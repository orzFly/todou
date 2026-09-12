import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OMP_EXTENSION_SOURCE } from "../../src/integrations/omp/extension.generated.ts";
import todou from "../../src/integrations/omp/extension.ts";
import { MAX_PAYLOAD_CHARS } from "../../src/peer-push.ts";

/** The literal as the extension spells it, underscores and all. */
function declared(name: string): number | undefined {
  const found = new RegExp(`const ${name} = ([0-9_]+);`).exec(
    OMP_EXTENSION_SOURCE,
  );
  return found ? Number(found[1]?.replaceAll("_", "")) : undefined;
}

describe("the omp extension's half of the push protocol", () => {
  /**
   * The extension runs inside omp and can import nothing from this package,
   * so the frame cap exists twice. Disagreement is invisible from both ends:
   * over its own cap the sender re-renders the batch as a cursor line, and a
   * receiver that stops earlier destroys the connection without a receipt —
   * which the sender reads as a delivery. This is the only thing that says so.
   */
  it("caps a frame where the sender does", () => {
    expect(declared("MAX_PAYLOAD_CHARS")).toBe(MAX_PAYLOAD_CHARS);
  });

  /**
   * Not a style rule: an import of anything outside node: would resolve
   * inside this repo and be missing wherever the file is actually installed.
   */
  it("imports nothing but Node built-ins", () => {
    const imported = [...OMP_EXTENSION_SOURCE.matchAll(/from "([^"]+)"/g)].map(
      (found) => found[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((from) => !from?.startsWith("node:"))).toEqual([]);
  });
});

/*
 * Everything below drives the real extension in this process. The cases above
 * only ever read it as a string, and a string cannot show that a gate never
 * closed: `authed.ok` was written by the auth branch and read by nobody, so a
 * `user` frame that reached `handle()` was delivered whatever had — or had not
 * — come before it.
 *
 * The predicate is whether `pi.sendMessage` was called, never the session log:
 * a delivered push reaches omp's log only at its next drain, which the card
 * measured as far as five hours later, so counting log lines understates
 * delivery by an order of magnitude. `extension.ts` is the file under test
 * rather than `OMP_EXTENSION_SOURCE` because `asset-sync.test.ts` already pins
 * the two together byte for byte, and this machine's node does not strip the
 * type annotations out of the string if it is run as a file.
 */

const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const dirs: string[] = [];
const instances: Array<{ stop: () => void }> = [];
const listeners: Server[] = [];
/** The connections each listener has accepted, keyed by its server. */
const peers = new WeakMap<Server, Set<Socket>>();

/** A frame shaped the way `peer-push.ts` writes one. */
const userFrame = (opts: { content?: string; from?: string } = {}) => {
  const msgId = randomUUID();
  return {
    msgId,
    line: JSON.stringify({
      type: "user",
      msg_id: msgId,
      ...(opts.from === undefined ? {} : { from: opts.from }),
      message: { content: opts.content ?? "hello from a watch", role: "user" },
    }),
  };
};

const authFrame = (token: string) => JSON.stringify({ type: "auth", token });

type Handler = (event: unknown, ctx: unknown) => void;

type Booted = {
  /** Every message the extension handed the agent. */
  sent: Array<{ content: string }>;
  socket: string;
  /** Where the extension keeps its own socket, for a receipt address. */
  dir: string;
  token: string;
};

/**
 * Runs the extension in this process against a fake `pi`, and returns the
 * socket it bound for itself.
 *
 * The socket path and the token are read back out of the environment rather
 * than re-derived, which is also what proves `claim()` ran: `session_start`
 * swallows every exception, so a claim that failed would show up as every case
 * below failing to connect instead of as one wrong answer.
 */
function boot(name: string): Booted {
  const runtime = mkdtempSync(join(tmpdir(), `todou-omp-${name}-`));
  dirs.push(runtime);
  process.env.XDG_RUNTIME_DIR = runtime;
  // A record for this pid left over from an earlier case reads as our own and
  // skips the claim entirely — and every case here runs under the same pid.
  delete process.env.TODOU_OMP_STATE;

  const sent: Array<{ content: string }> = [];
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, handler: Handler) {
      handlers[event] = [...(handlers[event] ?? []), handler];
    },
    sendMessage(message: { content: string }) {
      sent.push(message);
    },
  };
  todou(pi as never);
  handlers.session_start?.[0]?.(
    {},
    { sessionManager: { getSessionId: () => "test-session" } },
  );

  const socket = process.env.TODOU_MESSAGING_SOCKET;
  const token = process.env.TODOU_MESSAGING_TOKEN;
  if (socket === undefined || token === undefined || !existsSync(socket)) {
    throw new Error("the extension did not claim the environment");
  }
  let stopped = false;
  instances.push({
    stop() {
      if (stopped) return;
      stopped = true;
      handlers.session_shutdown?.[0]?.({}, {});
    },
  });
  return { sent, socket, token, dir: join(runtime, "todou-omp") };
}

/**
 * One connection, its frames written exactly as given, resolving once the
 * server has closed it.
 *
 * `close` is the edge the negative cases wait on, rather than a delay: a
 * connection the extension stopped on is destroyed, and one whose sender
 * ended its side is closed by the server's own end. Node reports a socket's
 * `data` before its `end`, so by the time this resolves the server has handled
 * every frame that reached it and `sent` is final.
 *
 * A reset is not a failure: a connection destroyed mid-write is one of the
 * answers being asserted. A connection that never opened is, because every
 * case below would otherwise pass for the wrong reason if the path dialled
 * were not the extension's socket at all.
 */
function exchange(socketPath: string, frames: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let opened = false;
    socket.on("connect", () => {
      opened = true;
      frames.forEach((frame, index) => {
        if (index === frames.length - 1) socket.end(frame);
        else socket.write(frame);
      });
    });
    socket.on("error", () => {});
    socket.on("close", () =>
      opened
        ? resolve()
        : reject(new Error(`never connected to ${socketPath}`)),
    );
  });
}

type ReceiptAddress = {
  /** What a frame names in `from` to reach this address. */
  from: string;
  path: string;
  received: string[];
  /** Resolves on the first line to arrive, and never on its own. */
  arrived: Promise<void>;
  /** Drops every connection on this address, so teardown can complete. */
  hangUp: () => void;
};

/**
 * A listener standing in for the sender's receipt address, at `dir`/`name`.
 *
 * `arrived` resolves on the first line to reach it, so a case expecting a
 * receipt waits on the receipt itself and not on a duration.
 */
function receiptListener(dir: string, name: string): Promise<ReceiptAddress> {
  const path = join(dir, name);
  const received: string[] = [];
  let announce: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (
        let nl = buffer.indexOf("\n");
        nl !== -1;
        nl = buffer.indexOf("\n")
      ) {
        received.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        announce();
      }
    });
  });
  listeners.push(server);
  peers.set(server, accepted);
  return new Promise((resolve) => {
    server.listen(path, () =>
      resolve({
        from: `uds:${path}`,
        path,
        received,
        arrived,
        hangUp: () => {
          for (const peer of accepted) peer.destroy();
        },
      }),
    );
  });
}

/**
 * Long enough for a receipt dial started on this machine to land or fail,
 * short enough that the two cases below read as instant.
 */
const RECEIPT_WINDOW_MS = 150;

/**
 * Waits for a receipt, failing with what was expected rather than with the
 * file's own five-second timeout: `arrived` never resolves on its own, so
 * without this the assertion that follows would never run and a run with no
 * receipt at all would report as silence rather than as this.
 *
 * Real time, and the one place this file spends it. There is no edge to wait
 * on instead: the absence of a receipt is the outcome, the dial is a real
 * socket, and the window is the only thing that separates "not yet" from
 * "never". Both the dial and the connection teardown start inside the same
 * synchronous block that `exchange` resolved in, so what is being waited out
 * is one round trip through this process's event loop; 150ms is that with a
 * wide margin. Paid on every run because a green run cannot tell the two
 * apart either — a case that skipped the wait would pass while proving
 * nothing.
 */
function arrives(receipt: ReceiptAddress): Promise<void> {
  return Promise.race([
    receipt.arrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`no receipt arrived on ${receipt.path}`)),
        RECEIPT_WINDOW_MS,
      ),
    ),
  ]);
}

afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // The extension's receipt dial leaves its own side open, and on this
          // node `close()` waits for every connection to go first — so the
          // peers are dropped here rather than left to decide when the suite
          // may end.
          for (const peer of peers.get(server) ?? []) peer.destroy();
          server.close(() => resolve());
        }),
    ),
  );
  for (const instance of instances.splice(0)) instance.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  delete process.env.TODOU_MESSAGING_SOCKET;
  delete process.env.TODOU_MESSAGING_TOKEN;
  delete process.env.TODOU_OMP_STATE;
  if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
});

describe("an unauthenticated push", () => {
  /*
   * Each case here delivered before the gate existed, and each is a shape a
   * real sender produces rather than a contrived one. They are the whole
   * evidence for the fix: the assertions that were already green — a wrong
   * token — say nothing about a gate that was never closed.
   */
  it("does not deliver a user frame with no auth line", async () => {
    const { sent, socket } = boot("no-auth");
    await exchange(socket, [`${userFrame().line}\n`]);
    expect(sent).toEqual([]);
  });

  /*
   * The sender writes its frame and hangs up without the newline often enough
   * that the receiver reads the last fragment as a whole line on `end`. That
   * path discards `handle`'s verdict, so nothing there destroys the socket —
   * which is why this case cannot share the one above.
   */
  it("does not deliver a user frame with no auth line and no newline", async () => {
    const { sent, socket } = boot("no-auth-no-newline");
    await exchange(socket, [userFrame().line]);
    expect(sent).toEqual([]);
  });

  /*
   * The measured shape of the bug: frames are handled in order within one
   * `data` event, so a user frame ahead of a bad auth frame is already
   * delivered by the time the bad one stops the connection. The `stop` that
   * the bad token causes protects only the lines after it.
   */
  it("does not deliver a user frame that arrives before the auth line", async () => {
    const { sent, socket } = boot("user-first");
    await exchange(socket, [`${userFrame().line}\n${authFrame("wrong")}\n`]);
    expect(sent).toEqual([]);
  });

  it("does not deliver a user frame behind a line that is not JSON", async () => {
    const { sent, socket } = boot("junk-first");
    await exchange(socket, ["not json\n", `${userFrame().line}\n`]);
    expect(sent).toEqual([]);
  });
});

describe("a push the gate already stopped", () => {
  /*
   * The control. Without it, a socket dialled somewhere other than the
   * extension's own would make every case above pass while proving nothing,
   * and the frames below never reaching `handle` would be invisible.
   */
  it("delivers a user frame behind a correct auth line", async () => {
    const { sent, socket, token } = boot("good-token");
    await exchange(socket, [
      `${authFrame(token)}\n${userFrame({ content: "carried" }).line}\n`,
    ]);
    expect(sent.map((message) => message.content)).toEqual(["carried"]);
  });

  /*
   * Whether the two lines land in one `data` event or two depends on how the
   * kernel segments the write and is not controlled from here. The assertion
   * is non-delivery either way, so the case is not flaky across both — it
   * merely exercises a slightly different path in each. Written down because
   * the two look like an unhandled race to the next reader.
   */
  it("does not deliver a user frame behind a wrong token in one write", async () => {
    const { sent, socket } = boot("bad-token-one-write");
    await exchange(socket, [`${authFrame("wrong")}\n${userFrame().line}\n`]);
    expect(sent).toEqual([]);
  });

  it("does not deliver a user frame behind a wrong token in two writes", async () => {
    const { sent, socket } = boot("bad-token-two-writes");
    await exchange(socket, [
      `${authFrame("wrong")}\n`,
      `${userFrame().line}\n`,
    ]);
    expect(sent).toEqual([]);
  });

  it("does not deliver a user frame behind an auth frame with no token", async () => {
    const { sent, socket } = boot("auth-without-token");
    await exchange(socket, ['{"type":"auth"}\n', `${userFrame().line}\n`]);
    expect(sent).toEqual([]);
  });
});

describe("what a refused push is told", () => {
  /*
   * Silence is the sender's word for delivery, so a batch dropped without a
   * receipt is one it believes was read and never re-sends. A sender whose
   * token went missing — only the socket in its environment, nothing beside
   * it — would lose every batch with nothing on either side to show for it.
   * The receipt is what turns that into a degradation the user sees.
   */
  it("answers an unauthenticated user frame with a refused receipt", async () => {
    const { socket, dir } = boot("refused-receipt");
    const receipt = await receiptListener(dir, "no-reply-todou-watch-1.sock");
    const frame = userFrame({ from: receipt.from });
    await exchange(socket, [`${frame.line}\n`]);
    await arrives(receipt);

    const [answered] = receipt.received.map((line) => JSON.parse(line));
    expect(answered.status).toBe("refused");
    expect(answered.type).toBe("control");
    expect(answered.action).toBe("peer_message_status");
    // Without this the sender correlates the receipt against no batch it has
    // outstanding and discards it — a refusal it never learns about.
    expect(answered.orig_msg_id).toBe(frame.msgId);
    expect(typeof answered.reason).toBe("string");
  });

  /*
   * Two extensions exchanging control frames must not answer each other, or
   * each refusal provokes another. `peer-push.ts` states the same rule for
   * its own listener; this is the receiving half of it.
   */
  it("says nothing to an unauthenticated control frame", async () => {
    const { socket, dir } = boot("control-silent");
    const receipt = await receiptListener(dir, "no-reply-todou-watch-2.sock");
    await exchange(socket, [
      `${JSON.stringify({
        type: "control",
        action: "peer_message_status",
        status: "refused",
        from: receipt.from,
        msg_id: randomUUID(),
      })}\n`,
    ]);
    await arrives(receipt).catch(() => {});
    expect(receipt.received).toEqual([]);
  });

  /*
   * The receipt address is attacker-chosen on this path — it arrives in the
   * frame, before anything has been authenticated — so honouring one outside
   * the extension's own directory would let an unauthenticated sender make
   * this process dial any `.sock` on the machine and write a JSON line into
   * it. The rule mirrors `bounceTarget()` on the sending side. A real
   * sender's address is built inside that directory already, which the case
   * above proves by landing its receipt there.
   */
  it("writes no receipt to an address outside its own directory", async () => {
    const { socket } = boot("receipt-elsewhere");
    const outside = mkdtempSync(join(tmpdir(), "todou-omp-elsewhere-"));
    dirs.push(outside);
    const elsewhere = await receiptListener(
      outside,
      "no-reply-todou-watch-3.sock",
    );
    await exchange(socket, [`${userFrame({ from: elsewhere.from }).line}\n`]);
    await arrives(elsewhere).catch(() => {});
    expect(elsewhere.received).toEqual([]);
  });
});

describe("the socket's own permissions", () => {
  /*
   * Node creates the socket node under the process umask — 0775 here, on a
   * machine with umask 002 — so the enclosing directory is the only fence,
   * and `mkdirSync`'s mode does not correct a directory an earlier run created
   * under a looser one. This mode is the second fence; the control case above
   * is what proves it does not keep the legitimate sender out.
   *
   * The connection comes first because the chmod cannot run earlier: the node
   * does not exist until `listen` has bound it, so the extension tightens it
   * in the listening callback, and a connection is only ever accepted after
   * that callback has fired. Stat-ing straight after `boot` would race it.
   */
  it("is not group- or world-writable", async () => {
    const { socket, token } = boot("socket-mode");
    await exchange(socket, [`${authFrame(token)}\n`]);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });
});
