import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OMP_WATCH_TOOL } from "../../src/follow-advice.ts";
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

  it("pins the tool name to the CLI's own spelling of it", () => {
    // `OMP_WATCH_TOOL` names the device `can-i-follow` tells an agent to
    // call; `TOOL_NAME` is what omp registers under. The extension cannot
    // import the CLI's constant, so the two spellings are pinned by test
    // instead — a silent disagreement would send every agent to a device
    // that does not exist.
    const found = /const TOOL_NAME = "([^"]+)";/.exec(OMP_EXTENSION_SOURCE);
    expect(found?.[1]).toBe(OMP_WATCH_TOOL);
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
  /** Every message the extension handed the agent, with the tier it asked for. */
  sent: Array<{ content: string; deliverAs?: string }>;
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

  const sent: Array<{ content: string; deliverAs?: string }> = [];
  const handlers: Record<string, Handler[]> = {};
  const pi = {
    on(event: string, handler: Handler) {
      handlers[event] = [...(handlers[event] ?? []), handler];
    },
    sendMessage(
      message: { content: string },
      options?: { deliverAs?: string },
    ) {
      sent.push({ ...message, deliverAs: options?.deliverAs });
    },
    // The suites above never drive the tool or the command; stubbed so the
    // extension's registrations cannot take the boot down.
    registerTool() {},
    registerCommand() {},
    arktype(definition: unknown) {
      return definition;
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
    // The tier decides when the agent reads it, and both tiers put the same
    // text in the session log: only `steer` cuts into the running turn.
    expect(sent.map((message) => message.deliverAs)).toEqual(["steer"]);
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
   * and `mkdirSync`'s mode does not correct a directory an earlier run
   * created under a looser one. This mode is the second fence; the control
   * case above is what proves it does not keep the legitimate sender out.
   *
   * The connection comes first because the chmod cannot run earlier: the
   * node does not exist until `listen` has bound it, so the extension
   * tightens it in the listening callback, and a connection is only ever
   * accepted after that callback has fired. Stat-ing straight after `boot`
   * would race it.
   */
  it("is not group- or world-writable", async () => {
    const { socket, token } = boot("socket-mode");
    await exchange(socket, [`${authFrame(token)}\n`]);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
  });
});

describe("the todou_watch tool (T-357)", () => {
  /**
   * The fake pi for this suite: everything `boot` has, plus what the
   * extension registers. Typed shallowly on purpose — the shapes here are
   * what omp was measured to hand over, and the extension must tolerate
   * them exactly as written.
   */
  type WatchBooted = {
    sent: Booted["sent"];
    /** Runs the registered tool and returns its text. */
    run: (args: unknown, ctx?: unknown) => Promise<string>;
    /** Runs /todou with arguments. */
    runCommand: (args: string[], ctx?: unknown) => Promise<void>;
    completions: (input: string) => Array<{ label: string }>;
  };

  function bootWatch(name: string, sessionCtx: unknown = {}): WatchBooted {
    const runtime = mkdtempSync(join(tmpdir(), `todou-omp-${name}-`));
    dirs.push(runtime);
    process.env.XDG_RUNTIME_DIR = runtime;
    delete process.env.TODOU_OMP_STATE;
    // Real time, and small: the grace is a real spawn-and-wait and no fake
    // timer reaches into the child process. 150ms is the shortest window
    // that still lets a shell start and exit inside it.
    process.env.TODOU_WATCH_START_GRACE_MS = "150";

    const sent: Booted["sent"] = [];
    const handlers: Record<string, Handler[]> = {};
    const tools: Array<Record<string, unknown>> = [];
    const commands: Array<[string, Record<string, unknown>]> = [];
    const pi = {
      on(event: string, handler: Handler) {
        handlers[event] = [...(handlers[event] ?? []), handler];
      },
      sendMessage(
        message: { content: string },
        options?: { deliverAs?: string },
      ) {
        sent.push({ ...message, deliverAs: options?.deliverAs });
      },
      registerTool(tool: Record<string, unknown>) {
        tools.push(tool);
      },
      registerCommand(commandName: string, command: Record<string, unknown>) {
        commands.push([commandName, command]);
      },
      arktype: (definition: unknown) => definition,
    };
    todou(pi as never);
    handlers.session_start?.[0]?.(
      {},
      // The extension keeps this ctx for its repaints — the same object the
      // host keeps writing `ui` and `hasUI` onto — so the widget cases hand
      // their recording UI in here, not to the tool call.
      {
        sessionManager: { getSessionId: () => "watch-session" },
        ...(sessionCtx as object),
      },
    );
    const tool = tools.find((entry) => entry.name === OMP_WATCH_TOOL);
    if (tool === undefined) throw new Error("the tool was not registered");
    const command = commands.find(([id]) => id === "todou")?.[1];
    if (command === undefined) {
      throw new Error("the command was not registered");
    }

    const run = async (args: unknown, ctx: unknown = {}) => {
      const execute = tool.execute as (
        id: string,
        a: unknown,
        s: unknown,
        u: unknown,
        c: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>;
      const result = await execute("call", args, undefined, undefined, ctx);
      return result.content[0]?.text ?? "";
    };
    const runCommand = async (args: string[], ctx: unknown = {}) => {
      const runIt = command.run as (c: unknown, a: string[]) => Promise<void>;
      await runIt(ctx, args);
    };
    const completions = (input: string) =>
      (
        command.getArgumentCompletions as (
          i: string,
        ) => Array<{ label: string; description: string }>
      )(input);

    let stopped = false;
    instances.push({
      stop() {
        if (stopped) return;
        stopped = true;
        handlers.session_shutdown?.[0]?.({}, {});
      },
    });
    return { sent, run, runCommand, completions };
  }

  /**
   * A `todou` stand-in: a shell script on a scratch path, so `TODOU_BIN`
   * exercises the real spawn. The body runs with a `pids` directory it can
   * write `$$` into; every case's cleanup and liveness check read it.
   */
  function fakeTodou(
    name: string,
    body: string,
  ): { bin: string; pids: string } {
    const dir = mkdtempSync(join(tmpdir(), `todou-fake-${name}-`));
    dirs.push(dir);
    const pids = join(dir, "pids");
    mkdirSync(pids, { recursive: true });
    const bin = join(dir, "todou");
    writeFileSync(
      bin,
      `#!/bin/sh\necho $$ > "${pids}/$$"\n${body}\nrm -f "${pids}/$$"\n`,
      { mode: 0o755 },
    );
    return { bin, pids };
  }

  /** The pids the fake todou left behind, i.e. the ones still running. */
  function livePids(pids: string): number[] {
    let names: string[] = [];
    try {
      names = readdirSync(pids);
    } catch {
      return [];
    }
    const alive: number[] = [];
    for (const name of names) {
      const pid = Number(name);
      try {
        process.kill(pid, 0);
        alive.push(pid);
      } catch {
        // Gone: either the case stopped it or the script finished. Remove
        // the marker so a later `gone` does not read a zombie as alive.
        rmSync(join(pids, name), { force: true });
      }
    }
    return alive;
  }

  /**
   * Polls liveness rather than sleeping: each pass is one /proc read, and
   * the bound is there only to turn a leak into a failure instead of a
   * hang. Real time again — the thing being waited on is a real process.
   */
  async function gone(pids: string): Promise<void> {
    for (let i = 0; i < 200 && livePids(pids).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(livePids(pids), "a watch leaked out of its case").toEqual([]);
  }

  /** Waits for `sent` to reach a count, on the same real-clock logic. */
  async function sentCount(booted: { sent: Booted["sent"] }, n: number) {
    for (let i = 0; i < 200 && booted.sent.length < n; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(booted.sent.length).toBe(n);
  }

  it("reports a child that exits inside the grace, with its stderr", async () => {
    const { bin } = fakeTodou("fail", 'echo "no project selected" >&2\nexit 1');
    process.env.TODOU_BIN = bin;
    const { run } = bootWatch("start-fail");
    const text = await run({ action: "start" });
    expect(text).toContain("could not start");
    // The CLI's own words, verbatim: they say more than this file can.
    expect(text).toContain("no project selected");
  });

  it("starts, lists, stops, and does not announce a tool stop", async () => {
    const { bin, pids } = fakeTodou("live", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const { run, sent } = bootWatch("start-stop");
    const started = await run({ action: "start" });
    expect(started).toMatch(/^started w1 — /);
    expect(started).toContain("--follow=uds");

    const list = await run({ action: "list" });
    expect(list).toContain("w1");
    expect(list).toContain("running");

    const stopped = await run({ action: "stop", id: "w1" });
    expect(stopped).toContain("stopped w1");
    await gone(pids);
    // The tool call's own return is the answer; a push about it would be
    // telling the model what it just did.
    expect(sent).toEqual([]);
  });

  it("returns the first watch's id for the same request again", async () => {
    const { bin } = fakeTodou("dedupe", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const { run } = bootWatch("dedupe");
    const first = await run({ action: "start", issue: "T-16" });
    expect(first).toMatch(/^started w1/);
    const again = await run({ action: "start", issue: "T-16" });
    expect(again).toContain("w1 is already following this");
    const list = await run({ action: "list" });
    // One entry, not two: the second start spawned nothing.
    expect(list.match(/^w\d/gm)).toEqual(["w1"]);
  });

  it("starts a fresh watch once the same-keyed one has ended", async () => {
    const { bin, pids } = fakeTodou("restart", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const { run, sent } = bootWatch("restart");
    const first = await run({ action: "start" });
    expect(first).toMatch(/^started w1/);
    // Kill it from outside the tool, the way a dead server would.
    const [pid] = livePids(pids);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    await sentCount({ sent }, 1);
    expect(sent[0]?.content).toContain("todou_watch w1 ended");
    const second = await run({ action: "start" });
    expect(second).toMatch(/^started w2/);
  });

  it("announces the stdout a dead child never handed over", async () => {
    // Sleeps past the grace, so it starts; then dies holding a cursor —
    // the exact shape a server-side hangup leaves behind.
    const { bin } = fakeTodou("cursor", "sleep 1\necho 'cursor: c1'\nexit 3");
    process.env.TODOU_BIN = bin;
    const { run, sent } = bootWatch("cursor");
    const text = await run({ action: "start" });
    expect(text).toMatch(/^started w1/);
    await sentCount({ sent }, 1);
    expect(sent[0]?.content).toContain("todou_watch w1 ended");
    expect(sent[0]?.content).toContain("cursor: c1");
  });

  it("tells a stop without an id where the ids are", async () => {
    const { bin } = fakeTodou("noid", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const { run } = bootWatch("noid");
    const text = await run({ action: "stop" });
    expect(text).toContain("stop needs an id");
    expect(text).toContain('"action": "list"');
  });

  it("spawns the child as a todou under this omp", async () => {
    // What a wrong environment costs: without OMPCODE the child's harness
    // detector reads Claude Code or nothing, and its pushes go to a session
    // that never waited for them. The state trio is the cheaper path to
    // the same channel, so all four are asserted from one dump.
    const { bin } = fakeTodou(
      "env",
      'env | grep -E "^(OMPCODE|TODOU_)" | sort >&2\nexit 7',
    );
    process.env.TODOU_BIN = bin;
    const { run } = bootWatch("env");
    const text = await run({ action: "start" });
    expect(text).toContain("OMPCODE=1");
    expect(text).toContain("TODOU_OMP_STATE=");
    expect(text).toContain("TODOU_MESSAGING_SOCKET=");
    expect(text).toContain("TODOU_MESSAGING_TOKEN=");
  });

  it("stops everything from /todou stop and pushes one message", async () => {
    // The cursor is the point: a watch SIGTERMed by the stop prints its
    // held batches and its `cursor:` line only as it dies, so the message
    // must be built after the exits, not when the command runs.
    const { bin, pids } = fakeTodou(
      "command",
      "trap 'echo \"cursor: c-all\" ; exit 0' TERM\nwhile true; do sleep 1; done",
    );
    process.env.TODOU_BIN = bin;
    const { run, runCommand, sent } = bootWatch("command");
    await run({ action: "start", issue: "T-16" });
    await run({ action: "start", issue: "T-18" });
    const notify: string[] = [];
    await runCommand(["stop"], {
      hasUI: false,
      ui: { notify: (t: string) => notify.push(t) },
    });
    await gone(pids);
    await sentCount({ sent }, 1);
    // One message for both, ids in it: each message is a fixed cost to the
    // receiving turn, which is the same reason a watch batches entries.
    expect(sent.length).toBe(1);
    expect(sent[0]?.content).toContain("w1");
    expect(sent[0]?.content).toContain("w2");
    expect(sent[0]?.content).toContain("cursor: c-all");
    expect(sent[0]?.content).not.toContain("(nothing was waiting)");
    // §5.9's second half, pinned: the exits deliver the message, so the
    // claim is true — the round that removed it here was over-broad.
    expect(notify[0]).toContain("stopped 2 watches. The agent has been told.");
  });

  it("pushes one message when the whole group dies at once", async () => {
    // The timing the case above cannot see: its fake sleeps in one-second
    // steps, which spreads two deaths a second apart, and a real todou's
    // TERM cleanup is short enough that a stop-all kills both in the same
    // instant. `exec` puts the signal on the sleep itself, the shortest
    // death this suite can stage. What it guards is that the group's
    // last-one-out check and the delivery read the same event: a check
    // reading one event from a callback on another sees "all settled"
    // once per member, and a stop then costs the receiving turn as many
    // messages as it stopped watches.
    const { bin, pids } = fakeTodou("together", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const { run, runCommand, sent } = bootWatch("together");
    await run({ action: "start", issue: "T-16" });
    await run({ action: "start", issue: "T-18" });
    await runCommand(["stop"], { hasUI: false });
    await gone(pids);
    await sentCount({ sent }, 1);
    // The duplicate is a late arrival rather than a missing one, and
    // `sentCount` returns on the first message — so the count is read a
    // beat after the last child was reaped, or the second one lands
    // outside the window and the case passes on a bug.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sent.length).toBe(1);
    expect(sent[0]?.content).toContain("w1");
    expect(sent[0]?.content).toContain("w2");
  });

  it("keeps a half-dead group's cursor when stop lands again", async () => {
    // The reviewer's exact window: stop-all, w1 dies, then a second stop
    // recomputes `live` to the still-living w2 alone. Without the
    // write-once group, w2's reassignment leaves w1's exit — already run
    // against a two-member group that never settled — with nobody to
    // report its cursor. The two children take their pace from the issue
    // they are started with, so the fast one is the fast one by request,
    // not by filesystem race.
    const { bin, pids } = fakeTodou(
      "stagger",
      'case "$*" in\n' +
        "*T-16*) trap 'echo \"cursor: c-fast\"; exit 0' TERM ;;\n" +
        "*) trap 'echo \"cursor: c-slow\"; sleep 0.3; exit 0' TERM ;;\n" +
        "esac\n" +
        // 0.05 rather than the other fakes' 1: a shell runs a trap only once
        // the foreground command has returned, so the sleep is also how late
        // a TERM may land — and the window this case aims at is 200ms wide.
        "while true; do sleep 0.05; done",
    );
    process.env.TODOU_BIN = bin;
    const { run, runCommand, sent } = bootWatch("stagger");
    await run({ action: "start", issue: "T-16" });
    await run({ action: "start", issue: "T-18" });
    await runCommand(["stop"], { hasUI: false });
    // 200ms: the fast child is dead, the slow one is inside its 0.3s trap.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The second stop, in the reviewer's window.
    await runCommand(["stop"], { hasUI: false });
    await gone(pids);
    // Both cursors, one message: the guard kept w2's group at the original
    // pair, so w1's exit had a settled set to report.
    await sentCount({ sent }, 1);
    expect(sent.length).toBe(1);
    expect(sent[0]?.content).toContain("cursor: c-fast");
    expect(sent[0]?.content).toContain("cursor: c-slow");
    expect(sent[0]?.content).not.toContain("(nothing was waiting)");
  });

  it("notifies for a single-id stop too, cursor included", async () => {
    // The path a bare `/todou stop` never exercises: one id, one exit, and
    // a message the command itself used to claim it had sent.
    const { bin, pids } = fakeTodou(
      "command-one",
      "trap 'echo \"cursor: c-one\" ; exit 0' TERM\nwhile true; do sleep 1; done",
    );
    process.env.TODOU_BIN = bin;
    const { run, runCommand, sent } = bootWatch("command-one");
    await run({ action: "start", issue: "T-16" });
    const notify: string[] = [];
    await runCommand(["stop", "w1"], {
      hasUI: false,
      ui: { notify: (t: string) => notify.push(t) },
    });
    await gone(pids);
    await sentCount({ sent }, 1);
    expect(sent[0]?.content).toContain("The user stopped 1");
    expect(sent[0]?.content).toContain("w1");
    expect(sent[0]?.content).toContain("cursor: c-one");
    // What the UI says has to be something that happened: the message is
    // the exit handler's, so the notify claims nothing about it.
    expect(notify[0]).toContain("stopping w1");
    expect(notify[0]).not.toContain("has been told");
  });

  it("paints one widget line, folding the fifth into and n more", async () => {
    const { bin } = fakeTodou(
      "widget",
      'echo "--follow=uds following $TODOU_FAKE_WANT" >&2\nexec sleep 30',
    );
    process.env.TODOU_BIN = bin;
    const lines: Array<string[] | undefined> = [];
    const { run } = bootWatch("widget", {
      cwd: dirname(bin),
      hasUI: true,
      ui: {
        setWidget: (_key: string, widget?: string[]) => lines.push(widget),
      },
    });
    // The want-line is what the real CLI prints from its own resolution;
    // the fake spells it from the environment the child inherits.
    for (const want of ["T-16", "other", "third", "fourth", "fifth"]) {
      process.env.TODOU_FAKE_WANT = want;
      await run({ action: "start", issue: want });
    }
    expect(lines.at(-1)).toEqual([
      "todou watch - T-16, other, third, fourth and 1 more",
    ]);
  });

  it("paints the model's spelling where an old CLI says nothing", async () => {
    const { bin } = fakeTodou("silent", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const lines: Array<string[] | undefined> = [];
    const { run } = bootWatch("silent", {
      cwd: dirname(bin),
      hasUI: true,
      ui: {
        setWidget: (_key: string, widget?: string[]) => lines.push(widget),
      },
    });
    await run({ action: "start", issue: "T-16" });
    expect(lines.at(-1)).toEqual(["todou watch - T-16"]);
  });

  it("paints nothing at all without a UI", async () => {
    const { bin } = fakeTodou("no-ui", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    let painted = 0;
    const { run } = bootWatch("no-ui", {
      cwd: dirname(bin),
      hasUI: false,
      ui: {
        setWidget: () => {
          painted += 1;
        },
      },
    });
    const text = await run({ action: "start" });
    expect(text).toMatch(/^started/);
    expect(painted).toBe(0);
  });

  it("starts fine with no ui object at all", async () => {
    const { bin } = fakeTodou("no-ui-object", "exec sleep 30");
    process.env.TODOU_BIN = bin;
    const { run } = bootWatch("no-ui-object");
    const text = await run({ action: "start" }, { cwd: dirname(bin) });
    expect(text).toMatch(/^started/);
  });

  it("completes /todou's stop argument", () => {
    const { completions } = bootWatch("complete");
    expect(completions("st")).toEqual([
      { label: "stop", description: "stop every watch, or one by id" },
    ]);
    expect(completions("x")).toEqual([]);
  });
});
