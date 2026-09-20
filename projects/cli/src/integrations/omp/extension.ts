/**
 * The todou extension omp loads, installed by `todou integration install omp`
 * (T-308). It is the source of truth for what gets written; the byte-for-byte
 * copy in `extension.generated.ts` is what the shipped CLI carries, because a
 * single-file bundle and four `deno compile` executables can take no resource
 * file along beside them.
 * Native Pi bundles this same machinery with its schema and host profile from
 * `../pi/extension.ts`; omp keeps the default profile and verbatim asset.
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
 *  1. Publishes which session omp is in, and where the socket below listens,
 *     to a file named after omp's pid — so that `todou` stops having to guess
 *     the session from session-log mtimes, and finds the channel from anywhere
 *     omp's curated environment does not reach.
 *  2. Listens for `todou watch --follow=uds`, speaking the same wire protocol
 *     Claude Code's messaging socket does, and hands each batch to the agent.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * The record layout `harness/omp-state.ts` will read.
 *
 * Adding a field does not bump it, and must not: every todou already installed
 * on the machine rejects a record whose version it does not know outright, so a
 * bump would make each of them unable to read the session id too, from the
 * moment this extension updates. Optional fields leave both generations
 * working — an old reader ignores what it has no name for, and a new one treats
 * their absence as the older extension that really is running.
 */
const STATE_VERSION = 1;

/**
 * The longest push this accepts, matched to the sender's own cap in
 * `src/peer-push.ts`. It is not a preference: over its limit the sender
 * re-renders the batch as a cursor and a "re-read it from the tracker" line,
 * and a receiver with a smaller number would drop full-size batches that the
 * sender believes it delivered. `omp-extension.test.ts` asserts they agree.
 */
const MAX_PAYLOAD_CHARS = 1_048_576;

/**
 * The tool this extension registers, published so `todou agent can-i-follow`
 * can tell an agent it exists. The name lives again in
 * `src/follow-advice.ts` (`OMP_WATCH_TOOL`) because this file may import
 * nothing from `src/`; a test pins the two spellings together.
 */
const TOOL_NAME = "todou_watch";

/** Enough that guessing it is not a way in; the socket's mode is the fence. */
const TOKEN_BYTES = 24;

export type ExtensionHost = {
  on(
    event: string,
    handler: (event: unknown, ctx: PiContext) => void | Promise<void>,
  ): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      attribution?: string;
    },
    options: { deliverAs: string; triggerTurn: boolean },
  ): void;
  registerTool(tool: RegisteredTool): void;
  registerCommand(name: string, command: RegisteredCommand): void;
  /** omp hangs arktype on the context; extensions cannot import it. */
  arktype?: (definition: unknown) => unknown;
};

type PiContext = {
  sessionManager?: {
    getSessionId?: () => unknown;
    getSessionFile?: () => unknown;
  };
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    setWidget?(key: string, lines?: string[]): void;
    notify?(text: string, level: string): void;
  };
};

type SessionIdentity = { id: string; file?: string };

/** One line of the push protocol, as far as this reads it. */
type Frame = {
  type?: unknown;
  token?: unknown;
  from?: unknown;
  msg_id?: unknown;
  message?: { content?: unknown };
};

/** A tool `pi.registerTool` takes, as far as this defines one. */
type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    args: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: PiContext,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

/**
 * One argument completion, as omp reads one. `value` is what replaces the
 * argument text, and omp reads it with no guard on a keystroke path that is
 * outside every try/catch — an item without it kills the session (T-396).
 */
type CompletionItem = {
  value: string;
  label: string;
  description?: string;
};

/**
 * A command `pi.registerCommand` takes. The callback is `handler`, taking the
 * text after the command name as one string and the context second; measured
 * against omp v18.1.21, not inferred — `registerCommand` stores the object
 * without looking at it, so a wrong shape is silent until a user types the
 * command (T-396).
 */
type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: PiContext) => void | Promise<void>;
  getArgumentCompletions?: (input: string) => CompletionItem[];
};

/** Host differences; the watch, command, widget and wire protocol stay shared. */
export type ExtensionProfile = {
  agent: "omp" | "pi";
  stateEnv: string;
  toolsEnv: string;
  childEnv: Record<string, string | undefined>;
  attribution?: string;
  reclaimOnStart: boolean;
};

const OMP_PROFILE: ExtensionProfile = {
  agent: "omp",
  stateEnv: "TODOU_OMP_STATE",
  toolsEnv: "TODOU_OMP_TOOLS",
  childEnv: { OMPCODE: "1" },
  attribution: "user",
  reclaimOnStart: false,
};

/**
 * One arktype field with its `.describe` text, through the builder the host
 * hands over — the only source of arktype an extension has.
 */
function described(
  arktype: (definition: unknown) => unknown,
  definition: string,
  text: string,
): unknown {
  const built = arktype(definition) as { describe?: (d: string) => unknown };
  return built.describe === undefined ? built : built.describe(text);
}

export default function todou(
  pi: ExtensionHost,
  profile: ExtensionProfile = OMP_PROFILE,
  parameters?: unknown,
): void {
  // Only omp evaluates this builder; Pi supplies native JSON Schema.
  const arktype = pi.arktype as (definition: unknown) => unknown;
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
  const connections = new Set<Socket>();
  let closed = false;
  let subordinate = false;
  let activeSessionId: string | undefined;
  let generation = 0;
  let lifecycle = Promise.resolve();

  /** Admission and lifecycle changes share one queue; child grace does not hold it. */
  function serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = lifecycle.then(operation);
    lifecycle = result.then(
      () => {},
      () => {},
    );
    return result;
  }

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
  function session(ctx: PiContext): SessionIdentity | undefined {
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
  function publish(here: SessionIdentity | undefined): void {
    if (!here || statePath === undefined) return;
    const temp = `${statePath}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({
        v: STATE_VERSION,
        pid: process.pid,
        agent: profile.agent,
        session_id: here.id,
        ...(here.file === undefined ? {} : { session_file: here.file }),
        // The push channel, published rather than left to be derived: omp
        // builds a curated environment for everything but its own bash tool,
        // so the pair `claim` exported reaches none of them and a todou run
        // from the `!` shell would see an omp with no channel at all. The
        // token could not be derived in any case, and deriving the socket from
        // this file's own name would tie the reader permanently to a naming
        // rule neither side ever wrote down.
        //
        // Written as a pair or not at all — a record carrying one of them is a
        // channel nothing can open.
        ...(socketPath === undefined || token === undefined
          ? {}
          : { socket: socketPath, token }),
        // What this session can do beyond push, so advice can name it. Same
        // optionality as the channel: an older reader ignores the field, and
        // a record without it is an older extension's.
        tools: [TOOL_NAME],
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
          // The body arrives as the sender rendered it and goes on
          // untouched: an omp receiver never parses an envelope out of it,
          // and the batch's own first line already names the command.
          customType: "todou",
          content,
          display: true,
          ...(profile.attribution === undefined
            ? {}
            : { attribution: profile.attribution }),
        },
        // Both hosts accept steering. omp can background a foreground bash
        // command; native Pi queues until the current tool calls finish.
        // `triggerTurn` starts a turn when the session is idle.
        { deliverAs: "steer", triggerTurn: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The address a receipt goes back to, or null. Same rule the sender applies
   * to replies — absolute, `.sock`, in the directory this channel listens in
   * — so an address that cannot be honoured is dropped rather than dialled.
   *
   * The directory is what keeps this from being a dialler an unauthenticated
   * frame can aim: `from` is read before anything is authenticated, so
   * without it any local `.sock` would be reachable by anyone who can open
   * this one. A real sender's receipt address is built in the target's own
   * directory, so the restriction costs it nothing.
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
    if (!isAbsolute(path) || !path.endsWith(".sock")) return null;
    if (socketPath === undefined) return null;
    return dirname(path) === dirname(socketPath) ? path : null;
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
      // what Claude Code does on the platform where it checks at all. The
      // undefined case is refused rather than passed: `listen()` is only ever
      // reached through `claim()`, which sets the token first, so today it
      // cannot happen — but read as "no token configured, let everything in"
      // it is the one default that would hold this gate open.
      if (token === undefined || frame.token !== token) return "stop";
      authed.ok = true;
      return "go";
    }
    // Before the frame type is looked at, not inside the `user` branch: every
    // frame type added later is behind the gate by default, and letting one
    // through takes an explicit edit here rather than remembering that this
    // check exists. Today the two placements behave identically, since `user`
    // is the only frame that is handled at all.
    // The sender's contract is that silence means delivery, so a batch
    // dropped here would be one it believes was read and never re-sends: a
    // legitimate sender whose token went missing — only the socket in its
    // environment, no token beside it — would lose every batch with nothing
    // on either side to show for it. A `control` frame gets no receipt even
    // unauthenticated, so two extensions exchanging them cannot bounce — the
    // same rule `peer-push.ts` states for its own side.
    if (!authed.ok) {
      if (frame.type === "user") {
        refuse(frame, "this push channel requires an auth line first");
      }
      return "stop";
    }
    if (frame.type !== "user") return "go";
    const content = frame.message?.content;
    if (typeof content !== "string") return "go";
    if (!deliver(content))
      refuse(frame, `the ${profile.agent} session could not take it`);
    return "go";
  }

  function listen(): void {
    if (socketPath === undefined) return;
    const path = socketPath;
    const listeningGeneration = generation;
    const current = () => !closed && generation === listeningGeneration;
    // A crash leaves the node behind and the bind would fail EADDRINUSE.
    rmSync(path, { force: true });
    const created = createServer((socket) => {
      if (!current()) {
        socket.destroy();
        return;
      }
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.setEncoding("utf8");
      let buffer = "";
      const authed = { ok: false };
      socket.on("data", (chunk: string) => {
        if (!current()) return socket.destroy();
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
        if (current() && line !== "") handle(line, authed);
      });
      socket.on("error", () => {});
    });
    // Nothing to do about a later listener error, and an unhandled one would
    // take omp down — which is the one thing this must never do.
    created.on("error", () => {});
    created.listen(path, () => {
      if (!current()) return;
      // Node creates the node under the process umask, so it lands group- and
      // world-writable on a machine with a permissive one, leaving the 0700
      // directory above as the only fence — and `mkdirSync`'s mode does not
      // correct a directory an earlier run created under a looser umask. Done
      // here rather than after `listen()` because the node does not exist
      // until this callback fires.
      try {
        chmodSync(path, 0o600);
      } catch {
        // A socket that could not be tightened is still a working channel,
        // and failing here would leave the extension unable to take any push.
      }
    });
    server = created;
  }

  async function shutdown(): Promise<void> {
    closed = true;
    generation += 1;
    // Revoke already authenticated peers before waiting for children. A partial
    // frame on an old connection must never complete into the next session.
    for (const connection of connections) connection.destroy();
    connections.clear();
    const previousServer = server;
    server = undefined;
    const serverClosed = new Promise<void>((resolve) => {
      if (previousServer === undefined) return resolve();
      try {
        previousServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    const previousWatches = [...watches.values()];
    for (const watch of previousWatches) stop(watch, "shutdown");
    watches.clear();
    paintWidget();
    await Promise.all([
      serverClosed,
      ...previousWatches.map((watch) => watch.ended),
    ]);
    // A sub-agent owns its watches, but never the root's manifest or socket.
    if (!owner) return;
    if (statePath !== undefined) rmSync(statePath, { force: true });
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
    if (process.env[profile.stateEnv] === statePath)
      delete process.env[profile.stateEnv];
    if (process.env.TODOU_MESSAGING_TOKEN === token) {
      delete process.env.TODOU_MESSAGING_SOCKET;
      delete process.env.TODOU_MESSAGING_TOKEN;
      delete process.env[profile.toolsEnv];
    }
    owner = false;
    statePath = undefined;
    socketPath = undefined;
    token = undefined;
  }

  /**
   * Claims a fresh channel generation for this process's tools. omp can retain
   * the environment captured at startup, so its tools must prefer the live
   * manifest over a stale socket/token snapshot after a session transition.
   */
  function claim(here: SessionIdentity | undefined): void {
    closed = false;
    const { state, socket } = paths();
    statePath = state;
    socketPath = socket;
    token = randomBytes(TOKEN_BYTES).toString("hex");
    process.env[profile.stateEnv] = state;
    process.env.TODOU_MESSAGING_SOCKET = socket;
    process.env.TODOU_MESSAGING_TOKEN = token;
    // The bash tool's cheap copy of the record's `tools` line, exactly as
    // the pair above is: one export instead of a record read.
    process.env[profile.toolsEnv] = TOOL_NAME;
    owner = true;
    publish(here);
    listen();
  }

  // ------------------------------------------------------------------
  // todou_watch (T-357): the watch tool this extension registers.
  // ------------------------------------------------------------------

  /**
   * How long after spawn a watch counts as started: an exit inside the
   * window is a failure with the child's stderr to show, and surviving it
   * is success. Read on every call rather than captured at import — a
   * module-level constant would be fixed before a test could shrink it.
   */
  function startGraceMs(): number {
    return Number(process.env.TODOU_WATCH_START_GRACE_MS) || 3000;
  }

  /**
   * Tail-capture bounds, in characters. stdout is large because it holds
   * the unconfirmed batches a uds watch prints only at its exit; both keep
   * the tail rather than the head because `cursor:` is the last line, and
   * losing the start of an old batch costs less than losing the cursor a
   * restart would resume from.
   */
  const CAPTURE_STDOUT = 65_536;
  const CAPTURE_STDERR = 8_192;

  /** One watch: the process, what was asked of it, what it left behind. */
  type Watch = {
    id: string;
    /** The request itself, minus defaults — the reuse key. */
    key: string;
    /** What the model passed, for the widget's fallback spelling. */
    args: { issue?: unknown; project?: unknown };
    argv: string[];
    cwd: string;
    child: ChildProcess;
    startedAt: number;
    stdout: string;
    stderr: string;
    /** The exit code once it is known; `null` while the process lives. */
    exit: number | null;
    /** Who stopped it, when something did; `null` while it runs on. */
    stoppedBy: "tool" | "command" | "shutdown" | null;
    ended: Promise<void>;
    killTimer?: NodeJS.Timeout;
    /**
     * The watches this one was stopped together with, when `/todou stop`
     * took a set: the one message for them waits for the last of the set.
     */
    stopGroup: Watch[] | null;
  };

  const watches = new Map<string, Watch>();
  let nextId = 1;

  /**
   * The ctx a repaint needs, stored from session_start/agent_start: an exit
   * event arrives with no context of its own, and the stored reference stays
   * current because the host writes `ui` and `hasUI` onto the same object
   * it handed over.
   */
  let uiContext: PiContext | undefined;

  /** The todou this tool runs: `TODOU_BIN`, else whatever PATH resolves. */
  function binary(): string {
    return process.env.TODOU_BIN || "todou";
  }

  /** The argv one start request turns into. */
  function argvFor(args: {
    issue?: unknown;
    project?: unknown;
    server?: unknown;
    since?: unknown;
    debounce?: unknown;
  }): string[] {
    const argv = args.issue === undefined ? ["watch"] : ["issue", "watch"];
    if (args.issue !== undefined) argv.push(String(args.issue));
    argv.push("--follow=uds");
    for (const option of [
      ["-p", args.project],
      ["--server", args.server],
      ["--since", args.since],
      ["--debounce", args.debounce],
    ] as const) {
      if (option[1] !== undefined && option[1] !== null) {
        argv.push(option[0], String(option[1]));
      }
    }
    return argv;
  }

  /** Explicit host markers keep nested agents' inherited env out of watches. */
  function childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...profile.childEnv,
      ...(statePath === undefined ? {} : { [profile.stateEnv]: statePath }),
      ...(socketPath === undefined
        ? {}
        : { TODOU_MESSAGING_SOCKET: socketPath }),
      ...(token === undefined ? {} : { TODOU_MESSAGING_TOKEN: token }),
    };
  }

  /** The reuse key: the request itself, plus the cwd it resolves against. */
  function keyFor(
    args: { issue?: unknown; project?: unknown; server?: unknown },
    cwd: string,
  ): string {
    return JSON.stringify([
      args.issue ?? null,
      args.project ?? null,
      args.server ?? null,
      cwd,
    ]);
  }

  /** The `the command` of every text below, spaced as one line. */
  function commandOf(watch: Watch): string {
    return `${binary()} ${watch.argv.join(" ")}`;
  }

  /** How long a watch ran, rounded to the unit that fits. */
  function elapsedOf(watch: Watch): string {
    const ms = Date.now() - watch.startedAt;
    return ms < 60_000
      ? `${Math.max(1, Math.round(ms / 1000))}s`
      : `${Math.round(ms / 60_000)}m`;
  }

  /**
   * What this watch follows, in the spelling the CLI printed — or, from an
   * older CLI that prints nothing, the nearest thing the model passed.
   */
  function followingOf(watch: Watch): string {
    const found = /^--follow=uds following (.+)$/m.exec(watch.stderr);
    if (found?.[1] !== undefined) return found[1];
    if (typeof watch.args.issue === "string" && watch.args.issue !== "") {
      return watch.args.issue;
    }
    if (typeof watch.args.project === "string" && watch.args.project !== "") {
      return watch.args.project;
    }
    return "?";
  }

  /** The one-line widget: what is being followed now, or nothing at all. */
  function paintWidget(): void {
    try {
      if (uiContext?.hasUI !== true) return;
      const setWidget = uiContext.ui?.setWidget;
      if (setWidget === undefined) return;
      const live = [...watches.values()].filter((watch) => watch.exit === null);
      if (live.length === 0) {
        setWidget("todou");
        return;
      }
      const names = live.map((watch) => followingOf(watch));
      const shown = names.slice(0, 4).join(", ");
      setWidget("todou", [
        names.length <= 4
          ? `todou watch - ${shown}`
          : `todou watch - ${shown} and ${names.length - 4} more`,
      ]);
    } catch {
      // A wrong guess about the UI costs a missing line, not a session;
      // the watches themselves are the point.
    }
  }

  /**
   * The message a watch that ended on its own owes the session: what it
   * had not handed over, and the cursor to resume from.
   */
  function endedText(watch: Watch): string {
    const head = `todou_watch ${watch.id} ended — ${commandOf(watch)} exited ${watch.exit} after ${elapsedOf(watch)}.`;
    const parts = [head];
    if (watch.stdout !== "") {
      parts.push("What it had not handed over, and the cursor to resume from:");
      parts.push("```");
      parts.push(watch.stdout);
      parts.push("```");
    }
    if (watch.stderr !== "") {
      parts.push("Its last output on stderr:");
      parts.push("```");
      parts.push(watch.stderr);
      parts.push("```");
    }
    return parts.join("\n\n");
  }

  /**
   * The message for watches the user stopped from `/todou` — one message
   * however many ended, because the receiving side charges each message a
   * fixed cost, the same reason a watch batches its entries.
   */
  function userStoppedText(all: Watch[]): string {
    const lines = all.map(
      (watch) =>
        `${watch.id}  ${followingOf(watch).padEnd(6)} ${commandOf(watch)}  ran ${elapsedOf(watch)}`,
    );
    const held = all
      .map(
        (watch) =>
          `${watch.id}:\n${watch.stdout === "" ? "(nothing was waiting)" : watch.stdout}`,
      )
      .join("\n\n");
    return [
      `The user stopped ${all.length} todou watch(es) from /todou. You were not asked, so this is the notification: nothing is following those cards or projects any more.`,
      "",
      "```",
      ...lines,
      "```",
      "What each had not handed over, and the cursor to resume from:",
      "",
      "```",
      held,
      "```",
    ].join("\n");
  }

  /**
   * Sends the one message for a `/todou stop` set, from whichever exit
   * landed last. It cannot be sent from the command itself: a watch
   * SIGTERMed by `stop()` prints its held batches and its cursor only as
   * it dies, so the message has to be built from output that each exit
   * event has by then captured.
   */
  function deliverStoppedByCommand(all: Watch[]): void {
    const settled = all.filter((watch) => watch.exit !== null);
    if (settled.length < all.length) return;
    deliver(userStoppedText(settled));
  }

  /** Stop one watch: record who, signal, and escalate if it lingers. */
  function stop(watch: Watch, by: "tool" | "command" | "shutdown"): void {
    if (watch.exit !== null) return;
    // Lifecycle disposal wins over a command stop already waiting for exit.
    if (watch.stoppedBy !== "shutdown") watch.stoppedBy = by;
    if (watch.killTimer !== undefined) return;
    try {
      watch.child.kill("SIGTERM");
    } catch {
      // Already gone; the exit event will record it.
    }
    // Keep this timer referenced: an awaited shutdown must reap even a child
    // ignoring TERM. Clear it on exit, rather than killing a reused numeric pid.
    watch.killTimer = setTimeout(() => {
      if (watch.exit !== null) return;
      try {
        watch.child.kill("SIGKILL");
      } catch {
        // The child exited between the check and the signal.
      }
    }, 1000);
  }

  /** The tool's `list`: processes, with what became of them. */
  function listText(): string {
    if (watches.size === 0) {
      return 'no watches in this session. `{"action": "start", "issue": "T-16"}` starts one.';
    }
    const lines = [...watches.values()].map((watch) => {
      const pid = watch.exit === null ? `pid ${watch.child.pid}  ` : "";
      return [
        watch.id.padEnd(3),
        followingOf(watch).padEnd(6),
        watch.exit === null
          ? `running ${elapsedOf(watch)}`
          : `exited ${watch.exit}, ${elapsedOf(watch)} ago`,
        `${pid}${commandOf(watch)}`,
        `in ${watch.cwd}`,
      ]
        .join("  ")
        .replace(/\s+$/, "");
    });
    return [
      `${watches.size} ${watches.size === 1 ? "watch" : "watches"} in this session:`,
      "",
      "```",
      ...lines,
      "```",
      "These are processes, not tracker positions: a watch pushing over this channel writes nothing until it ends, so there is no cursor to report here.",
    ].join("\n");
  }

  /** Start one watch, or report why that is not happening. */
  async function startWatch(
    args: {
      issue?: unknown;
      project?: unknown;
      server?: unknown;
      since?: unknown;
      debounce?: unknown;
    },
    ctx: PiContext,
    requested: SessionIdentity | undefined,
    requestedGeneration: number,
  ): Promise<string> {
    if (closed) return "could not start — this session is closing.";
    if (
      requested
        ? requested.id !== activeSessionId
        : requestedGeneration !== generation
    ) {
      return "could not start — the session changed before the watch started.";
    }
    const watchGeneration = generation;
    const cwd = typeof ctx.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : ".";
    const key = keyFor(args, cwd);
    for (const watch of watches.values()) {
      if (watch.key === key && watch.exit === null) {
        return [
          `${watch.id} is already following this — ${commandOf(watch)} (pid ${watch.child.pid}, running ${elapsedOf(watch)})`,
          "",
          "Nothing was started. Stop it first if you want to restart it with different arguments.",
        ].join("\n");
      }
    }
    const id = `w${nextId}`;
    nextId += 1;
    const argv = argvFor(args);
    let child: ChildProcess;
    try {
      child = spawn(binary(), argv, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
        env: childEnv(),
      });
    } catch (error) {
      return couldNotStart(argv, cwd, error);
    }
    const watch: Watch = {
      id,
      key,
      args: { issue: args.issue, project: args.project },
      argv,
      cwd,
      child,
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      exit: null,
      stoppedBy: null,
      stopGroup: null,
      ended: Promise.resolve(),
    };
    watches.set(id, watch);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      watch.stdout = (watch.stdout + chunk).slice(-CAPTURE_STDOUT);
    });
    child.stderr?.on("data", (chunk: string) => {
      watch.stderr = (watch.stderr + chunk).slice(-CAPTURE_STDERR);
    });
    const ended = new Promise<void>((resolve) => {
      child.on("exit", (code) => {
        watch.exit = code ?? -1;
        clearTimeout(watch.killTimer);
        resolve();
      });
      child.on("error", () => {
        watch.exit = -1;
        clearTimeout(watch.killTimer);
        resolve();
      });
    });
    watch.ended = ended;
    // Exit beats the timer: a child that died in milliseconds has its own
    // stderr to show and never needed the grace period to say so.
    await Promise.race([
      ended,
      new Promise<void>((resolve) =>
        setTimeout(resolve, startGraceMs()).unref(),
      ),
    ]);
    if (generation !== watchGeneration || closed) {
      return "could not start — the session changed while the watch was starting.";
    }
    if (watch.exit === -1 && watch.stderr === "" && watch.stdout === "") {
      // spawn's ENOENT arrives here rather than in the throw: the message
      // the model needs is the one about PATH and TODOU_BIN.
      return couldNotStart(argv, cwd, undefined);
    }
    if (watch.exit !== null) {
      return [
        `could not start — ${commandOf(watch)} exited ${watch.exit} after ${elapsedOf(watch)}, in ${watch.cwd}`,
        "",
        watch.stderr,
      ]
        .join("\n")
        .replace(/\s+$/, "");
    }
    // `exit`, and it has to stay `exit`: `deliverStoppedByCommand` decides
    // whether a group is complete by reading `watch.exit`, which is set
    // above on this same event. Moving only the delivery to `close` — the
    // event that drains stdio, and the tempting one for that reason — puts
    // every member's `exit` before any member's `close`, so a stop-all
    // where the children die together has each `close` find the group
    // complete and push the message again. The four-member case in
    // `omp-extension.test.ts` is what holds this: it fails every run on an
    // idle machine, and only sometimes on a loaded one, because load is
    // what pairs a child's own two events back up.
    watch.child.on("exit", (code) => {
      // The second registration, for the real end of a watch that outlived
      // its grace: repaint, then decide what the session is told. A tool's
      // own stop and the session ending are the two silences; everything
      // else is said here — not in `stop()` — because this is the moment
      // the child's last output exists to say it with.
      watch.exit = code ?? -1;
      if (generation !== watchGeneration || closed) return;
      paintWidget();
      if (watch.stoppedBy === "tool" || watch.stoppedBy === "shutdown") {
        return;
      }
      if (watch.stoppedBy === "command") {
        deliverStoppedByCommand(watch.stopGroup ?? [watch]);
        return;
      }
      deliver(endedText(watch));
    });
    paintWidget();
    return [
      `started ${watch.id} — ${commandOf(watch)} (pid ${watch.child.pid}, in ${watch.cwd})`,
      "",
      `Activity will arrive as a message. \`{"action": "stop", "id": "${watch.id}"}\` ends it; it also ends with this session.`,
    ].join("\n");
  }

  /** The two start failures that are not the child's own stderr. */
  function couldNotStart(argv: string[], cwd: string, error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || error === undefined) {
      return [
        `could not start — \`${binary()}\` is not on PATH in this ${profile.agent} session. ${profile.agent} inherits the PATH of the shell it was started from, so either start ${profile.agent} from a shell where \`${binary()}\` resolves, or export \`TODOU_BIN=<path to ${binary()}>\` before starting it.`,
      ].join("\n");
    }
    return [
      `could not start — ${binary()} ${argv.join(" ")} in ${cwd}: ${String(error)}`,
    ].join("\n");
  }

  function syncSession(ctx: PiContext, replace: boolean, mayClaim: boolean) {
    // Managers can mutate while cleanup awaits a child; publish the identity
    // observed at this completed event, never a later manager value.
    let here: SessionIdentity | undefined;
    try {
      here = session(ctx);
    } catch {
      return Promise.resolve();
    }
    return serialize(async () => {
      if (!here) return;
      const changed =
        activeSessionId !== undefined && here.id !== activeSessionId;
      if (changed || (replace && activeSessionId !== undefined)) {
        await shutdown();
      }
      uiContext = ctx;
      activeSessionId = here.id;
      if (owner) {
        publish(here);
      } else if (subordinate) {
        closed = false;
      } else if (mayClaim || changed) {
        const existing = process.env[profile.stateEnv];
        if (
          !profile.reclaimOnStart &&
          existing !== undefined &&
          ours(existing)
        ) {
          subordinate = true;
          closed = false;
        } else {
          claim(here);
        }
      }
      paintWidget();
    }).catch(() => {
      // A failed extension must not take its host down.
    });
  }

  pi.on("session_start", (_event, ctx) =>
    syncSession(ctx, profile.reclaimOnStart, true),
  );
  // Completed events only: cancelled before-switch/branch/tree events leave
  // the current session and every watch intact.
  if (!profile.reclaimOnStart) {
    for (const event of ["session_switch", "session_branch", "session_tree"]) {
      pi.on(event, (_event, ctx) => syncSession(ctx, false, false));
    }
  }
  pi.on("agent_start", (_event, ctx) => syncSession(ctx, false, false));
  pi.on("session_shutdown", () =>
    serialize(shutdown).catch(() => {
      // Leaves a stale record, which the reader rejects on the dead pid.
    }),
  );

  pi.registerCommand("todou", {
    description: "what todou is following in this session, and how to stop it",
    async handler(argsText, ctx) {
      // omp hands over the text after the command name as one string, so the
      // split is ours to do. Whitespace, not `" "`: `/todou   stop   w1`
      // arrives verbatim, and single-space splitting would put empty strings
      // where the arguments are. No fallback for a non-string `argsText`
      // either — `String(argsText ?? "")` would turn a host that changed
      // shape again into a silent walk down the list branch, where throwing
      // gets the line omp prints for a command that failed.
      const args = argsText.trim().split(/\s+/).filter(Boolean);
      try {
        if (args[0] === "stop") {
          const live = [...watches.values()].filter(
            (watch) => watch.exit === null,
          );
          if (args[1] !== undefined) {
            const watch = watches.get(args[1]);
            if (watch === undefined || watch.exit !== null) {
              ctx.ui?.notify?.(
                `no watch called "${args[1]}". /todou lists them.`,
                "info",
              );
              return;
            }
            // The notification is the exit handler's to send, not this
            // one's: only once the child has died does its stdout hold
            // what it had not handed over. Grouped with itself, so the
            // handler sees "all settled" on that one exit.
            watch.stopGroup = watch.stopGroup ?? [watch];
            stop(watch, "command");
            ctx.ui?.notify?.(`stopping ${watch.id}.`, "info");
            return;
          }
          if (live.length === 0) {
            ctx.ui?.notify?.("nothing to stop.", "info");
            return;
          }
          // One message for all of them, sent by whichever exit lands
          // last — the receiving side charges each message a fixed cost,
          // which is the same reason a watch batches its entries, and no
          // child's held output exists before its own exit.
          // Write-once: a second stop inside the death window must not
          // re-group watches that are already waiting on this set, or an
          // early exit's "not all settled" can outlive the set it checked.
          for (const watch of live) {
            watch.stopGroup = watch.stopGroup ?? live;
          }
          for (const watch of live) stop(watch, "command");
          // True now, which is the point: the exits carry the message, and
          // this copy is design §5.9's, restored after the round that
          // removed it for saying something no path delivered.
          ctx.ui?.notify?.(
            `stopped ${live.length} watches. The agent has been told.`,
            "info",
          );
          paintWidget();
          return;
        }
        const live = [...watches.values()].filter(
          (watch) => watch.exit === null,
        );
        if (live.length === 0) {
          ctx.ui?.notify?.(
            "todou is not following anything in this session. The agent starts a watch with its todou_watch tool.",
            "info",
          );
          return;
        }
        const summary = live
          .map((watch) => `${watch.id} ${followingOf(watch)}`)
          .join(", ");
        ctx.ui?.notify?.(
          `following ${live.length} — ${summary}. /todou stop ends all of them, /todou stop ${live[0]?.id ?? ""} just that one.`,
          "info",
        );
      } catch {
        // As ever: this must not take the session down.
      }
    },
    getArgumentCompletions(input) {
      // The trailing space is omp's own convention and load-bearing: `value`
      // replaces the whole argument text, so `"stop "` leaves the caret past
      // it ready for an id, where `"stop"` would glue the next character on
      // as `/todou stopw1`.
      return "stop".startsWith(input)
        ? [
            {
              value: "stop ",
              label: "stop",
              description: "stop every watch, or one by id",
            },
          ]
        : [];
    },
  });

  // No `loadMode`: the default is `discoverable`, which mounts the tool as
  // `xd://todou_watch` — absent from the tool list, present for `read` and
  // `write` (design.md §1). Every string below is reviewed copy (§5).
  pi.registerTool({
    name: TOOL_NAME,
    label: "todou watch",
    description: [
      `Follow a todou tracker card, or a whole project, from this ${profile.agent} session. Activity arrives as a message in your session as it happens, so you do not have to re-open a watch, or remember to.`,
      "",
      "```",
      '{"action": "start", "issue": "T-16"}   follow one card',
      '{"action": "start"}                    follow every card of a project',
      '{"action": "list"}                     what is running right now',
      '{"action": "stop", "id": "w1"}         end one',
      "```",
      "",
      "`issue` takes any spelling todou accepts — `T-16`, `16`, `proj/16`, or a full URL. Left out, the watch covers the whole project.",
      "",
      `\`project\` and \`server\` are optional. Left out, each is resolved from the directory this ${profile.agent} session is running in, exactly as every other todou command resolves it; \`todou config show\` prints what that directory settles. A directory that settles neither fails the call and says so — nothing here guesses. \`project\` also takes a comma-separated list, which follows several projects as one stream.`,
      "",
      '`since` resumes from a cursor an earlier command printed, and is how a watch started after a `spec push` or a `comment add` catches the answer to it. Without it the watch starts at "now" and anything already on the card is skipped.',
      "",
      "`debounce` is the batching window in seconds. It defaults to 60, and `0` delivers each entry as it lands.",
      "",
      "The same arguments twice do not start a second watch: the second call returns the first one's id. But two calls that differ only in whether `project` was spelled out count as two watches even when they resolve to the same project — this tool does not resolve them, the todou CLI does, inside the child process, and nothing here can see that the two agreed.",
      "",
      `A watch that ends for any reason other than \`stop\` delivers what it had not handed over, and the cursor to resume from, as a message. Every watch ends with this ${profile.agent} session.`,
    ].join("\n"),
    // arktype's object form takes a definition per key and no description
    // element — `["string", "…"]` is a load error (measured, v18.1.21) —
    // so each field is built, described, and composed in one expression.
    parameters:
      parameters ??
      arktype({
        action: described(
          arktype,
          "string",
          "start a watch, stop one, or list what is running",
        ),
        "issue?": described(
          arktype,
          "string",
          'the card to follow — "T-16", "16", "proj/16", or a full URL. Leave it out to follow the whole project',
        ),
        "project?": described(
          arktype,
          "string",
          `project slug, or a comma-separated list of them. Left out, it is resolved from the directory ${profile.agent} is running in`,
        ),
        "server?": described(
          arktype,
          "string",
          "server origin. Left out, it is resolved the same way",
        ),
        "since?": described(
          arktype,
          "string",
          'cursor to resume from. Without it the watch starts at "now"',
        ),
        "debounce?": described(
          arktype,
          "string",
          "batching window in seconds; 60 by default, 0 delivers each entry as it lands",
        ),
        "id?": described(
          arktype,
          "string",
          "which watch to stop, from a start or a list",
        ),
      }),
    async execute(_toolCallId, argsRaw, _signal, _onUpdate, ctx) {
      try {
        const args =
          typeof argsRaw === "object" && argsRaw !== null
            ? (argsRaw as Record<string, unknown>)
            : {};
        if (args.action === "list") {
          return { content: [{ type: "text", text: listText() }] };
        }
        if (args.action === "stop") {
          if (typeof args.id !== "string" || args.id === "") {
            return {
              content: [
                {
                  type: "text",
                  text: 'stop needs an id — `{"action": "list"}` shows them.',
                },
              ],
            };
          }
          const watch = watches.get(args.id);
          if (watch === undefined) {
            return {
              content: [
                {
                  type: "text",
                  text: `no watch called "${args.id}" in this session — \`{"action": "list"}\` shows them.`,
                },
              ],
            };
          }
          if (watch.exit !== null) {
            watches.delete(args.id);
            return {
              content: [
                {
                  type: "text",
                  text: `${args.id} had already ended (exit ${watch.exit}). Its record is gone now.`,
                },
              ],
            };
          }
          stop(watch, "tool");
          return {
            content: [
              {
                type: "text",
                text: `stopped ${watch.id} — ${commandOf(watch)}, after ${elapsedOf(watch)}`,
              },
            ],
          };
        }
        if (args.action === "start") {
          // Return the grace promise inside an object so admission releases the
          // queue immediately; a transition can stop a still-starting child.
          const requested = session(ctx);
          const requestedGeneration = generation;
          const admitted = await serialize(() => ({
            result: startWatch(args, ctx, requested, requestedGeneration),
          }));
          const text = await admitted.result;
          return { content: [{ type: "text", text }] };
        }
        return {
          content: [
            {
              type: "text",
              text: `unknown action "${String(args.action)}" — start, stop, or list.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `todou_watch failed: ${String(error)}` },
          ],
        };
      }
    },
  });
}
