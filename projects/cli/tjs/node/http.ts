// node:http for the tjs build: a loopback `createServer`, as `todou login`'s
// one-shot callback listener uses it, on top of tjs.serve.
import { Buffer } from "buffer";

type Listener = (...args: unknown[]) => void;
type Headers = Record<string, string | number>;

/**
 * How long a response callback waits after the response has been handed to
 * tjs. Node calls it once the bytes are with the kernel; tjs.serve gives no
 * such signal, and the login listener closes the whole server from that
 * callback, which must not cut off the page the browser is about to show.
 */
const FLUSH_GRACE_MS = 250;

class IncomingMessage {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly #request: Request;
  readonly #listeners = new Map<string, Listener[]>();
  #reading = false;

  constructor(request: Request) {
    const url = new URL(request.url);
    this.#request = request;
    this.method = request.method;
    this.url = `${url.pathname}${url.search}`;
    this.headers = Object.fromEntries(request.headers);
  }

  on(event: string, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    if (event === "data" && !this.#reading) {
      this.#reading = true;
      void this.#pump();
    }
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  async #pump(): Promise<void> {
    try {
      if (this.#request.body !== null) {
        for await (const chunk of this.#request.body) {
          this.#emit("data", Buffer.from(chunk));
        }
      }
      this.#emit("end");
    } catch (error) {
      this.#emit("error", error);
    }
  }
}

class ServerResponse {
  readonly #respond: (response: Response) => void;
  #status = 200;
  #headers: Headers = {};
  #ended = false;

  constructor(respond: (response: Response) => void) {
    this.#respond = respond;
  }

  writeHead(status: number, headers: Headers = {}): this {
    this.#status = status;
    this.#headers = { ...this.#headers, ...headers };
    return this;
  }

  end(
    bodyOrCallback?: string | Uint8Array | (() => void),
    callback?: () => void,
  ): this {
    if (this.#ended) return this;
    this.#ended = true;
    const body =
      typeof bodyOrCallback === "function" ? undefined : bodyOrCallback;
    const done =
      typeof bodyOrCallback === "function" ? bodyOrCallback : callback;
    // A 302 or 303 carries no body; an empty Response body is still a body.
    const headers = new globalThis.Headers();
    for (const [name, value] of Object.entries(this.#headers)) {
      headers.set(name, String(value));
    }
    this.#respond(
      new Response(
        body === undefined || body.length === 0 ? null : (body as BodyInit),
        { status: this.#status, headers },
      ),
    );
    if (done !== undefined) setTimeout(done, FLUSH_GRACE_MS);
    return this;
  }
}

class Server {
  readonly #handler: (req: IncomingMessage, res: ServerResponse) => void;
  #server: ReturnType<typeof tjs.serve> | undefined;
  #host = "127.0.0.1";

  constructor(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    this.#handler = handler;
  }

  listen(port: number, host: string, callback?: () => void): this {
    this.#host = host;
    this.#server = tjs.serve({
      port,
      listenIp: host,
      fetch: (request: Request) =>
        new Promise<Response>((resolve) => {
          this.#handler(
            new IncomingMessage(request),
            new ServerResponse(resolve),
          );
        }),
    });
    if (callback !== undefined) queueMicrotask(callback);
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    return this.#server === undefined
      ? null
      : { address: this.#host, family: "IPv4", port: this.#server.port };
  }

  close(callback?: (error?: Error) => void): this {
    const closing = this.#server?.close() ?? Promise.resolve();
    void closing.then(
      () => callback?.(),
      (error: Error) => callback?.(error),
    );
    return this;
  }
}

export function createServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Server {
  return new Server(handler);
}
