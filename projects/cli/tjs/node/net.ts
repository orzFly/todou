// node:net for the tjs build: `createServer` and `connect` on a Unix socket
// or a Windows named pipe, which is all peer-push asks of them, on tjs'
// PipeServerSocket and PipeSocket.
import { Buffer } from "buffer";

type Listener = (...args: unknown[]) => void;

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
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: Listener): this {
    const list = this.#listeners.get(event);
    const at = list?.lastIndexOf(listener) ?? -1;
    if (list !== undefined && at !== -1) list.splice(at, 1);
    return this;
  }

  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (list === undefined || list.length === 0) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }
}

/**
 * Node's message for a failed connect is `connect ENOENT /path`; for a failed
 * listen it adds libuv's description: `listen EADDRINUSE: address already in
 * use /path`. The code is passed through unchanged, which is what callers
 * branch on.
 */
function netError(error: unknown, syscall: "connect" | "listen", path: string) {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return error;
  const description = (error as Error).message.replace(/^[A-Z]+: /, "");
  const wrapped = new Error(
    syscall === "connect"
      ? `connect ${code} ${path}`
      : `listen ${code}: ${description} ${path}`,
  ) as Error & { code: string; syscall: string; address: string };
  wrapped.code = code;
  wrapped.syscall = syscall;
  wrapped.address = path;
  return wrapped;
}

class Socket extends Emitter {
  readonly #pipe: PipeSocket;
  #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  #encoding: "utf8" | null = null;
  #closed = false;

  constructor(pipe: PipeSocket, path: string, connecting: boolean) {
    super();
    this.#pipe = pipe;
    pipe.opened.then(
      ({ readable, writable }) => {
        this.#writer = writable.getWriter();
        if (connecting) this.emit("connect");
        void this.#read(readable);
      },
      (error: unknown) => {
        this.emit(
          "error",
          connecting ? netError(error, "connect", path) : error,
        );
        this.#close(true);
      },
    );
  }

  setEncoding(encoding: "utf8"): this {
    this.#encoding = encoding;
    return this;
  }

  async #read(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        this.emit(
          "data",
          this.#encoding === null ? chunk : chunk.toString("utf8"),
        );
      }
      this.emit("end");
    } catch (error) {
      if (this.#closed) return;
      this.emit("error", error);
      this.#close(true);
      return;
    }
    // Node's default (allowHalfOpen false) ends its own side once the peer
    // has ended, and then the socket closes.
    this.end();
  }

  write(
    data: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    this.#writes = this.#writes.then(async () => {
      try {
        await this.#writer?.write(bytes);
        callback?.(null);
      } catch (error) {
        callback?.(error as Error);
      }
    });
    return true;
  }

  end(data?: string | Uint8Array, callback?: () => void): this {
    if (data !== undefined) this.write(data);
    void this.#writes.then(async () => {
      try {
        await this.#writer?.close();
      } catch {
        // Already closed by the peer; the end is what was asked for anyway.
      }
      callback?.();
      this.#close(false);
    });
    return this;
  }

  destroy(): this {
    this.#close(false);
    return this;
  }

  #close(hadError: boolean): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pipe.close();
    queueMicrotask(() => this.emit("close", hadError));
  }
}

class Server extends Emitter {
  readonly #onConnection: (socket: Socket) => void;
  #server: PipeServerSocket | undefined;
  #path = "";

  constructor(onConnection: (socket: Socket) => void) {
    super();
    this.#onConnection = onConnection;
  }

  listen(path: string, callback?: () => void): this {
    this.#path = path;
    const server = new PipeServerSocket(path);
    this.#server = server;
    server.opened.then(
      ({ readable }) => {
        callback?.();
        this.emit("listening");
        void this.#accept(readable);
      },
      (error: unknown) => {
        this.emit("error", netError(error, "listen", path));
      },
    );
    return this;
  }

  async #accept(readable: ReadableStream<PipeSocket>): Promise<void> {
    try {
      for await (const pipe of readable) {
        this.#onConnection(new Socket(pipe, this.#path, false));
      }
    } catch (error) {
      this.emit("error", error);
    }
  }

  address(): string {
    return this.#path;
  }

  /** libuv unlinks the socket node when the handle closes, as under Node. */
  close(callback?: () => void): this {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      queueMicrotask(() => callback?.());
      return this;
    }
    server.close();
    void server.closed.then(
      () => {
        this.emit("close");
        callback?.();
      },
      () => callback?.(),
    );
    return this;
  }
}

export function createServer(onConnection: (socket: Socket) => void): Server {
  return new Server(onConnection);
}

export function connect(path: string): Socket {
  return new Socket(new PipeSocket(path), path, true);
}
