/**
 * The todou extension omp loads, installed by `todou integration install omp`
 * (T-308). It is the source of truth for what gets written; the byte-for-byte
 * copy in `extension.generated.ts` is what the shipped CLI carries, because a
 * single-file bundle and four `deno compile` executables can take no resource
 * file along beside them.
 *
 * It runs inside omp, never inside this CLI: nothing here may import from the
 * rest of `src/`, and only Node built-ins are available. It lives under `src/`
 * all the same so that `tsc` and biome see it — 200 lines inside a template
 * literal would have neither.
 *
 * It does two things, and every callback below is wrapped so that neither can
 * take omp down with it. A todou that cannot read the state file falls back to
 * the session scan it used before this existed, which is the right outcome for
 * a broken extension and the reason the try/catch is not a formality.
 *
 *  1. Publishes which session omp is in, to a file named after omp's pid, so
 *     that `todou` running under the bash tool stops having to guess from
 *     session-log mtimes.
 *  2. Listens for `todou watch --follow=uds`, speaking the same wire protocol
 *     Claude Code's messaging socket does, and hands each batch to the agent.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

/** The record layout `harness/omp-state.ts` will read; bump both together. */
const STATE_VERSION = 1;

/**
 * The longest push this accepts, matched to the sender's own cap in
 * `src/peer-push.ts`. It is not a preference: over its limit the sender
 * re-renders the batch as a cursor and a "re-read it from the tracker" line,
 * and a receiver with a smaller number would drop full-size batches that the
 * sender believes it delivered. `omp-extension.test.ts` asserts they agree.
 */
const MAX_PAYLOAD_CHARS = 1_048_576;

/** Enough that guessing it is not a way in; the socket's mode is the fence. */
const TOKEN_BYTES = 24;

type Pi = {
  on(event: string, handler: (event: unknown, ctx: PiContext) => void): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      attribution: string;
    },
    options: { deliverAs: string; triggerTurn: boolean },
  ): void;
};

type PiContext = {
  sessionManager?: {
    getSessionId?: () => unknown;
    getSessionFile?: () => unknown;
  };
};

/** One line of the push protocol, as far as this reads it. */
type Frame = {
  type?: unknown;
  token?: unknown;
  from?: unknown;
  msg_id?: unknown;
  message?: { content?: unknown };
};

export default function todou(pi: Pi): void {
  /**
   * Whether this instance is the one that publishes. `task` runs a sub-agent
   * through a second copy of this extension in the same process, with a
   * session id of its own, and both its tools and the root's must report the
   * root session — which is what omp itself reports, and what claude-code
   * means by a session id.
   *
   * Everything downstream keys off this rather than off `ctx.hasUI`, which is
   * false in `-p` print mode and would silently exclude every non-interactive
   * run — most of them, for an agent.
   */
  let owner = false;
  let statePath: string | undefined;
  let socketPath: string | undefined;
  let token: string | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let closed = false;

  /** Where this process's pair of files live, created on first use. */
  function paths(): { state: string; socket: string } {
    // Not the agent directory: a unix socket path is capped near 108 bytes,
    // and an agent directory holding an encoded project path clears that
    // easily. The bind then fails with EINVAL, which is indistinguishable
    // from the sandbox refusing unix sockets — a real degradation this must
    // not be able to imitate.
    const dir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "todou-omp");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return {
      state: join(dir, `${process.pid}.json`),
      socket: join(dir, `${process.pid}.sock`),
    };
  }

  /**
   * True when an inherited `TODOU_OMP_STATE` is this process's own — a
   * sub-agent of ours, which must not republish.
   *
   * An omp started from another omp's bash tool inherits the variable too,
   * and that one names the *parent's* pid: it has to claim the environment
   * for its own children, or every tool it runs would report a session in a
   * different process.
   */
  function ours(path: string): boolean {
    return basename(path, ".json") === String(process.pid);
  }

  /** The session omp holds at this instant, or nothing worth publishing. */
  function session(ctx: PiContext): { id: string; file?: string } | undefined {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id !== "string" || id === "") return undefined;
    const file = ctx?.sessionManager?.getSessionFile?.();
    return typeof file === "string" && file !== "" ? { id, file } : { id };
  }

  /**
   * Publishes the current session. Written to a sibling and renamed, because
   * the reader is a separate process that may look at any moment and a
   * half-written record would read as corrupt — which costs it the whole
   * fast path for the length of one write.
   */
  function publish(ctx: PiContext): void {
    const here = session(ctx);
    if (!here || statePath === undefined) return;
    const temp = `${statePath}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({
        v: STATE_VERSION,
        pid: process.pid,
        agent: "omp",
        session_id: here.id,
        ...(here.file === undefined ? {} : { session_file: here.file }),
        updated_at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    renameSync(temp, statePath);
  }

  /** Hands one push to the agent; false when it could not be delivered. */
  function deliver(content: string): boolean {
    if (closed) return false;
    try {
      pi.sendMessage(
        {
          // The envelope arrives already wrapped and goes on untouched: it
          // carries the `from` and `from-name` the agent reads to know who is
          // talking to it, and the sender compares its own serialization of
          // those attributes byte for byte.
          customType: "todou",
          content,
          display: true,
          attribution: "user",
        },
        // `priority: "next"` on the wire: a batch of tracker activity is news
        // for the next turn, not an interruption of this one.
        { deliverAs: "nextTurn", triggerTurn: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The address a receipt goes back to, or null. Same rule the sender applies
   * to replies — absolute, `.sock` — so an address that cannot be honoured is
   * dropped rather than dialled.
   */
  function replyTo(from: unknown): string | null {
    if (typeof from !== "string" || !from.startsWith("uds:")) return null;
    const raw = from.slice("uds:".length);
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      path = raw;
    }
    return isAbsolute(path) && path.endsWith(".sock") ? path : null;
  }

  /**
   * Says a push did not land. Sent only on failure: the sender treats silence
   * as delivery — a session set to accept sends no receipt either — so a
   * "delivered" frame would be one more thing for it to ignore, while a
   * missing "refused" is a batch it believes was read and never re-sends.
   */
  function refuse(frame: Frame, reason: string): void {
    const target = replyTo(frame.from);
    if (target === null || socketPath === undefined) return;
    const payload = `${JSON.stringify({
      type: "control",
      action: "peer_message_status",
      status: "refused",
      reason,
      // Correlates against the sender's outstanding batches; without it the
      // receipt arrives about no message in particular and is discarded.
      ...(typeof frame.msg_id === "string"
        ? { orig_msg_id: frame.msg_id }
        : {}),
      msg_id: randomUUID(),
      from: `uds:${socketPath}`,
    })}\n`;
    try {
      const socket = connect(target);
      socket.on("error", () => socket.destroy());
      socket.on("connect", () => socket.end(payload));
    } catch {
      // A receipt that cannot be sent leaves the sender waiting out its
      // window and then assuming success — the same as any other silence.
    }
  }

  function handle(line: string, authed: { ok: boolean }): "stop" | "go" {
    if (line.trim() === "") return "go";
    let frame: Frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return "go"; // Foreign or half-written: not ours to answer.
    }
    if (frame.type === "auth") {
      // A wrong token gets the connection closed and no receipt, which is
      // what Claude Code does on the platform where it checks at all.
      if (token !== undefined && frame.token !== token) return "stop";
      authed.ok = true;
      return "go";
    }
    if (frame.type !== "user") return "go";
    const content = frame.message?.content;
    if (typeof content !== "string") return "go";
    if (!deliver(content)) refuse(frame, "the omp session could not take it");
    return "go";
  }

  function listen(): void {
    if (socketPath === undefined) return;
    const path = socketPath;
    // A crash leaves the node behind and the bind would fail EADDRINUSE.
    rmSync(path, { force: true });
    const created = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      const authed = { ok: false };
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        // Measured before the split, exactly as the sender assumes: its cap
        // covers the auth line, the frame and the newline together.
        if (buffer.length > MAX_PAYLOAD_CHARS) {
          socket.destroy();
          return;
        }
        for (
          let nl = buffer.indexOf("\n");
          nl !== -1;
          nl = buffer.indexOf("\n")
        ) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (handle(line, authed) === "stop") {
            socket.destroy();
            return;
          }
        }
      });
      // A sender that writes its frame and hangs up may never send the
      // newline, so the last fragment is a whole line once the end arrives.
      socket.on("end", () => {
        const line = buffer;
        buffer = "";
        if (line !== "") handle(line, authed);
      });
      socket.on("error", () => {});
    });
    // Nothing to do about a later listener error, and an unhandled one would
    // take omp down — which is the one thing this must never do.
    created.on("error", () => {});
    created.listen(path);
    server = created;
  }

  function shutdown(): void {
    closed = true;
    try {
      server?.close();
    } catch {
      // Already closed, or never opened.
    }
    server = undefined;
    if (statePath !== undefined) rmSync(statePath, { force: true });
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
  }

  /**
   * Claims the environment for this process's tools. It runs once, because
   * omp fixes the environment its tools inherit early in the session and
   * every later write to `process.env` is invisible to them — measured, and
   * the reason the session id itself is not a variable: after a `/resume` it
   * would be a stale value that looks precise.
   */
  function claim(ctx: PiContext): void {
    const { state, socket } = paths();
    statePath = state;
    socketPath = socket;
    token = randomBytes(TOKEN_BYTES).toString("hex");
    process.env.TODOU_OMP_STATE = state;
    process.env.TODOU_MESSAGING_SOCKET = socket;
    process.env.TODOU_MESSAGING_TOKEN = token;
    owner = true;
    publish(ctx);
    listen();
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      if (owner) {
        publish(ctx);
        return;
      }
      const existing = process.env.TODOU_OMP_STATE;
      if (existing !== undefined && ours(existing)) return;
      claim(ctx);
    } catch {
      // An extension that throws here takes the session with it.
    }
  });

  // `/new` and `/resume` swap the session inside a running process, and the
  // session manager has already switched by the time this arrives — so the
  // current value is simply read, with nothing to wait for or retry.
  pi.on("session_switch", (_event, ctx) => {
    try {
      if (owner) publish(ctx);
    } catch {
      // Leaves the previous record in place, which the reader will believe.
    }
  });

  // Re-sync rather than a claim: a reload can replace this extension mid-run
  // without another session_start, and a turn is the moment the answer is
  // about to be asked for.
  pi.on("agent_start", (_event, ctx) => {
    try {
      if (owner) publish(ctx);
    } catch {
      // As above.
    }
  });

  pi.on("session_shutdown", () => {
    try {
      if (owner) shutdown();
    } catch {
      // Leaves a stale record, which the reader rejects on the dead pid.
    }
  });
}
