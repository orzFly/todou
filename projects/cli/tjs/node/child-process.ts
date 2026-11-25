// node:child_process for the tjs build: spawn and execFile, as the CLI calls
// them. Errors, exit codes and the order of `exit` before `close` follow
// Node; the children's own pipes are tjs' Web streams underneath.
import { Buffer } from "buffer";
import { platform } from "../platform.ts";

type Listener = (...args: unknown[]) => void;
type Stdio = "pipe" | "inherit" | "ignore";
type Env = Record<string, string | undefined>;

export interface SpawnOptions {
  cwd?: string;
  env?: Env;
  stdio?: Stdio | readonly Stdio[];
  shell?: boolean | string;
  detached?: boolean;
  windowsHide?: boolean;
}

export interface ExecFileOptions {
  cwd?: string;
  env?: Env;
  encoding?: BufferEncoding | "buffer" | null;
  timeout?: number;
  maxBuffer?: number;
  windowsHide?: boolean;
}

/** Node drops variables whose value is undefined; tjs would pass "undefined". */
function cleanEnv(env: Env | undefined): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/**
 * Node's `shell: true`: the command line joined with spaces, handed to
 * /bin/sh or to cmd.exe. Node passes cmd its line verbatim; tjs has no
 * verbatim mode, so libuv quotes the one argument, and `/s` strips those
 * quotes again.
 */
function shellCommand(
  file: string,
  args: readonly string[],
  shell: boolean | string,
): string[] {
  const line = [file, ...args].join(" ");
  if (platform === "win32") {
    const cmd =
      typeof shell === "string" ? shell : process.env.ComSpec || "cmd.exe";
    return [cmd, "/d", "/s", "/c", line];
  }
  return [typeof shell === "string" ? shell : "/bin/sh", "-c", line];
}

function spawnError(error: unknown, file: string, args: readonly string[]) {
  const code = (error as { code?: unknown } | null)?.code;
  const wrapped = new Error(
    `spawn ${file}${typeof code === "string" ? ` ${code}` : ""}`,
  ) as Error & {
    code?: string;
    syscall: string;
    path: string;
    spawnargs: readonly string[];
  };
  if (typeof code === "string") wrapped.code = code;
  wrapped.syscall = `spawn ${file}`;
  wrapped.path = file;
  wrapped.spawnargs = args;
  return wrapped;
}

class Emitter {
  readonly #listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: Listener): this {
    const list = this.#listeners.get(event);
    const at = list?.lastIndexOf(listener) ?? -1;
    if (list !== undefined && at !== -1) list.splice(at, 1);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (list === undefined || list.length === 0) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }
}

/** A child's stdout or stderr: `data` events and async iteration, in Buffers. */
class ChildOutput extends Emitter {
  readonly #stream: ReadableStream<Uint8Array>;
  #encoding: BufferEncoding | null = null;
  #flowing = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    super();
    this.#stream = stream;
  }

  setEncoding(encoding: BufferEncoding): this {
    this.#encoding = encoding;
    return this;
  }

  override on(event: string, listener: Listener): this {
    super.on(event, listener);
    if (event === "data" && !this.#flowing) {
      this.#flowing = true;
      void this.#pump();
    }
    return this;
  }

  async #pump(): Promise<void> {
    try {
      for await (const chunk of this.#stream) {
        const buffer = Buffer.from(chunk);
        this.emit(
          "data",
          this.#encoding === null ? buffer : buffer.toString(this.#encoding),
        );
      }
      this.emit("end");
    } catch (error) {
      this.emit("error", error);
    }
    this.emit("close");
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
    for await (const chunk of this.#stream) {
      const buffer = Buffer.from(chunk);
      yield this.#encoding === null ? buffer : buffer.toString(this.#encoding);
    }
  }
}

class ChildInput {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(stream: WritableStream<Uint8Array>) {
    this.#writer = stream.getWriter();
  }

  write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#writer.write(bytes).then(
      () => callback?.(null),
      (error: Error) => callback?.(error),
    );
    return true;
  }

  end(chunk?: string | Uint8Array, callback?: () => void): this {
    if (chunk !== undefined) this.write(chunk);
    this.#writer.close().then(
      () => callback?.(),
      () => callback?.(),
    );
    return this;
  }
}

class ChildProcess extends Emitter {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin: ChildInput | null = null;
  stdout: ChildOutput | null = null;
  stderr: ChildOutput | null = null;
  #process: tjs.Process | undefined;

  /** @internal */
  start(argv: string[], options: SpawnOptions): void {
    const stdio =
      typeof options.stdio === "string" || options.stdio === undefined
        ? [
            options.stdio ?? "pipe",
            options.stdio ?? "pipe",
            options.stdio ?? "pipe",
          ]
        : options.stdio;
    try {
      this.#process = tjs.spawn(argv, {
        cwd: options.cwd,
        env: cleanEnv(options.env),
        stdin: stdio[0] ?? "pipe",
        stdout: stdio[1] ?? "pipe",
        stderr: stdio[2] ?? "pipe",
      });
    } catch (error) {
      // Node reports a failed spawn as an `error` event on the next tick,
      // never as a throw, so listeners attached after the call still see it.
      const failure = spawnError(error, argv[0] ?? "", argv.slice(1));
      queueMicrotask(() => {
        this.emit("error", failure);
        this.emit("close", -2, null);
      });
      return;
    }
    const child = this.#process;
    this.pid = child.pid;
    if (child.stdin !== null) this.stdin = new ChildInput(child.stdin);
    if (child.stdout !== null) this.stdout = new ChildOutput(child.stdout);
    if (child.stderr !== null) this.stderr = new ChildOutput(child.stderr);
    void child.wait().then((status) => {
      this.exitCode = status.term_signal === null ? status.exit_status : null;
      this.signalCode = status.term_signal;
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
    });
  }

  kill(signal: string = "SIGTERM"): boolean {
    try {
      this.#process?.kill(signal as tjs.Signal);
      return true;
    } catch {
      return false;
    }
  }

  /** The tjs entry exits on its own once main returns; nothing to release. */
  unref(): this {
    return this;
  }

  ref(): this {
    return this;
  }
}

/**
 * `detached` is accepted and ignored: tjs cannot start a child in its own
 * session. The one caller, the browser opener, starts a program that hands
 * the URL over and exits at once.
 */
export function spawn(
  file: string,
  argsOrOptions?: readonly string[] | SpawnOptions,
  maybeOptions?: SpawnOptions,
): ChildProcess {
  const args = Array.isArray(argsOrOptions)
    ? (argsOrOptions as readonly string[])
    : [];
  const options =
    (Array.isArray(argsOrOptions)
      ? maybeOptions
      : (argsOrOptions as SpawnOptions)) ?? {};
  const argv = options.shell
    ? shellCommand(file, args, options.shell)
    : [file, ...args];
  const child = new ChildProcess();
  child.start(argv, options);
  return child;
}

type ExecFileCallback = (
  error:
    | (Error & {
        code?: number | string;
        killed?: boolean;
        signal?: string | null;
        cmd?: string;
      })
    | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

/**
 * Collects both outputs and reports through the callback the way Node does:
 * a non-zero exit is an error carrying the exit code as `code`, a failed
 * spawn is an error carrying the errno name.
 */
export function execFile(
  file: string,
  args: readonly string[] = [],
  optionsOrCallback?: ExecFileOptions | ExecFileCallback,
  maybeCallback?: ExecFileCallback,
): ChildProcess {
  const options =
    typeof optionsOrCallback === "function" ? {} : (optionsOrCallback ?? {});
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
  const encoding = options.encoding === undefined ? "utf8" : options.encoding;
  const decode = (bytes: Buffer) =>
    encoding === "buffer" || encoding === null
      ? bytes
      : bytes.toString(encoding);

  const child = spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on("data", (chunk) => out.push(chunk as Buffer));
  child.stderr?.on("data", (chunk) => err.push(chunk as Buffer));

  let killed = false;
  const timer =
    options.timeout !== undefined && options.timeout > 0
      ? setTimeout(() => {
          killed = true;
          child.kill();
        }, options.timeout)
      : undefined;

  let settled = false;
  const settle = (error: Parameters<ExecFileCallback>[0]) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback?.(error, decode(Buffer.concat(out)), decode(Buffer.concat(err)));
  };

  // The callback waits for both pipes to reach their end as well as for the
  // exit: a process can exit before its last output has been read.
  let pending = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0) + 1;
  let exit: { code: number | null; signal: string | null } | null = null;
  const finish = () => {
    pending -= 1;
    if (pending > 0 || exit === null) return;
    if (exit.code === 0 && !killed) {
      settle(null);
      return;
    }
    const stderrText = Buffer.concat(err).toString("utf8");
    const cmd = [file, ...args].join(" ");
    const error = new Error(
      `Command failed: ${cmd}\n${stderrText}`,
    ) as Error & {
      code?: number | string;
      killed?: boolean;
      signal?: string | null;
      cmd?: string;
    };
    error.code = exit.code ?? undefined;
    error.killed = killed;
    error.signal = exit.signal;
    error.cmd = cmd;
    settle(error);
  };
  child.stdout?.on("close", finish);
  child.stderr?.on("close", finish);
  child.on("exit", (code, signal) => {
    exit = { code: code as number | null, signal: signal as string | null };
    finish();
  });
  child.on("error", (error) => {
    settle(error as Error & { code?: string });
  });
  return child;
}
