// The `process` global of the tjs build: the members design.md's subset table
// lists, with Node's semantics where the CLI can observe them.
import { Buffer } from "buffer";
import { arch, platform } from "./platform.ts";
import { DatabaseSync } from "./sqlite.ts";

type Listener = (...args: unknown[]) => void;

const encoder = new TextEncoder();

/** The bits of EventEmitter the CLI and its dependencies call. */
class Emitter {
  readonly #listeners = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    this.added(event);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event);
    if (list === undefined) return this;
    const at = list.lastIndexOf(listener);
    if (at !== -1) list.splice(at, 1);
    if (list.length === 0) {
      this.#listeners.delete(event);
      this.removed(event);
    }
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    for (const key of event === undefined
      ? [...this.#listeners.keys()]
      : [event]) {
      if (this.#listeners.delete(key)) this.removed(key);
    }
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (list === undefined) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }

  listenerCount(event: string | symbol): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  protected added(_event: string | symbol): void {}
  protected removed(_event: string | symbol): void {}
}

/**
 * stdout or stderr. Writes are queued on the stream's one writer, in order,
 * so `write` can return at once the way Node's does; `flushed` is what the
 * entry point awaits before it exits.
 */
class Output extends Emitter {
  readonly #stream: typeof tjs.stdout;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #last: Promise<void> = Promise.resolve();
  readonly isTTY: boolean;

  constructor(stream: typeof tjs.stdout) {
    super();
    this.#stream = stream;
    this.#writer = stream.getWriter();
    this.isTTY = stream.isTerminal;
  }

  get columns(): number | undefined {
    return this.isTTY ? this.#stream.width : undefined;
  }

  get rows(): number | undefined {
    return this.isTTY ? this.#stream.height : undefined;
  }

  write(
    chunk: string | Uint8Array,
    encodingOrCallback?: string | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    const written = bytes.length === 0 ? this.#last : this.#writer.write(bytes);
    // A closed pipe (`todou … | head`) rejects every write after it; the
    // output is unwanted by then, and Node's own answer is to stop writing.
    this.#last = written.catch(() => {});
    if (done !== undefined) {
      written.then(
        () => done(null),
        (error: Error) => done(error),
      );
    }
    return true;
  }

  end(chunk?: string | Uint8Array, callback?: () => void): this {
    if (chunk !== undefined) this.write(chunk);
    if (callback !== undefined) void this.#last.then(callback);
    return this;
  }

  /** Resolves once every write so far has reached the stream. */
  flushed(): Promise<void> {
    return this.#last;
  }
}

/**
 * stdin: async-iterable in Buffer chunks, as Node's is. The reader is taken on
 * first use and kept, so that a prompt after a drain, or two prompts in a row,
 * read from the same stream without fighting over its lock.
 */
class Input extends Emitter {
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  readonly isTTY: boolean;

  constructor() {
    super();
    this.isTTY = tjs.stdin.isTerminal;
  }

  setRawMode(enable: boolean): this {
    tjs.stdin.setRawMode(enable);
    return this;
  }

  /** The next chunk, or null at end of input. */
  async read(): Promise<Buffer | null> {
    this.#reader ??= tjs.stdin.getReader();
    const { done, value } = await this.#reader.read();
    return done || value === undefined ? null : Buffer.from(value);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) return;
      yield chunk;
    }
  }

  // Node's stdin stops keeping the process alive once paused or unref'd; the
  // tjs entry exits on its own, so there is nothing to release.
  pause(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

const SIGNALS = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
  "SIGUSR1",
  "SIGUSR2",
  "SIGPIPE",
  "SIGWINCH",
  "SIGBREAK",
]);

class Process extends Emitter {
  readonly argv = [tjs.exePath, tjs.exePath, ...tjs.args.slice(1)];
  readonly env = tjs.env as Record<string, string | undefined>;
  readonly platform = platform;
  readonly pid = tjs.pid;
  readonly ppid = tjs.ppid;
  readonly execPath = tjs.exePath;
  readonly stdin = new Input();
  readonly stdout = new Output(tjs.stdout);
  readonly stderr = new Output(tjs.stderr);
  readonly versions: Record<string, string> = { tjs: tjs.version };
  exitCode: number | string | undefined = undefined;

  readonly #bridges = new Map<string, () => void>();

  /** Read live: the entry fills it in once detectPlatform has resolved. */
  get arch(): NodeJS.Architecture {
    return arch;
  }

  cwd(): string {
    return tjs.cwd;
  }

  getuid(): number {
    return tjs.system.userInfo.userId;
  }

  /**
   * Signal 0 asks whether a pid exists, and tjs.kill takes only named
   * signals. SIGCHLD stands in for it: the kernel applies the same existence
   * and permission checks to every signal, so ESRCH and EPERM come back
   * exactly as for 0, and SIGCHLD's default action is to be ignored. A
   * process that handles it must already tolerate a spurious one, since
   * POSIX lets several child exits collapse into a single delivery.
   *
   * Windows has no harmless signal at all: every one uv_kill knows there ends
   * the process. There the probe answers "alive" for any pid, which is the
   * conservative side of pid.ts' trade: a leftover file rather than a
   * listening watch's socket unlinked.
   */
  kill(pid: number, signal: string | number = "SIGTERM"): true {
    if (signal === 0) {
      if (this.platform === "win32") return true;
      tjs.kill(pid, "SIGCHLD");
      return true;
    }
    tjs.kill(pid, signal as tjs.Signal);
    return true;
  }

  getBuiltinModule(id: string): unknown {
    return id === "node:sqlite" || id === "sqlite"
      ? { DatabaseSync }
      : undefined;
  }

  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
    queueMicrotask(() => callback(...args));
  }

  protected override added(event: string | symbol): void {
    if (typeof event !== "string" || !SIGNALS.has(event)) return;
    if (this.#bridges.has(event)) return;
    const bridge = () => {
      this.emit(event, event);
    };
    this.#bridges.set(event, bridge);
    tjs.addSignalListener(event as tjs.Signal, bridge);
  }

  // Once nothing listens, libuv puts the default disposition back, so a
  // re-raised signal terminates the process as it would under Node.
  protected override removed(event: string | symbol): void {
    if (typeof event !== "string") return;
    const bridge = this.#bridges.get(event);
    if (bridge === undefined) return;
    this.#bridges.delete(event);
    tjs.removeSignalListener(event as tjs.Signal, bridge);
  }
}

export const process = new Process();
