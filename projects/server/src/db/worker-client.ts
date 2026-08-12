import { Worker } from "node:worker_threads";

// biome-ignore lint/suspicious/noExplicitAny: raw wire values
type Any = any;

type Pending = { resolve: (v: Any) => void; reject: (e: Error) => void };

/**
 * A crash-looping worker (e.g. corrupt data directory) dies before any
 * query succeeds; stop respawning after this many exits in a row so the
 * failure surfaces as fast errors instead of a spawn loop.
 */
const MAX_CONSECUTIVE_CRASHES = 3;

/**
 * Main-thread proxy that satisfies the query surface drizzle-orm/pglite
 * uses (query / exec / transaction) while the real PGlite instance runs in
 * a worker thread. Controlled by `database.projects.workers` (default on
 * under dedicated placement).
 *
 * Crash policy: if the worker exits unexpectedly, every in-flight request
 * is rejected (never silently retried — writes are not idempotent) and a
 * fresh worker reopens the same data directory, so the next query finds
 * recovered data. In-memory databases cannot recover their contents, so a
 * crash there fails the handle instead of silently serving an empty one.
 */
export class WorkerPgliteClient {
  #dataDir?: string;
  #worker!: Worker;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #txSeq = 0;
  #closed = false;
  #consecutiveCrashes = 0;
  #failed: Error | null = null;

  constructor(dataDir?: string) {
    this.#dataDir = dataDir;
    this.#spawn();
  }

  #spawn(): void {
    const worker = new Worker(new URL("./pglite-worker.ts", import.meta.url), {
      workerData: { dataDir: this.#dataDir },
    });
    this.#worker = worker;
    worker.on(
      "message",
      (msg: { id: number; result?: Any; error?: string }) => {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        // Any reply proves this worker generation is functional.
        this.#consecutiveCrashes = 0;
        if (msg.error !== undefined) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      },
    );
    // An uncaught exception in the worker emits "error" then "exit"; keep
    // the throw site so the crash report names it, and let the exit
    // handler do the actual cleanup.
    let crashCause: Error | undefined;
    worker.on("error", (err: unknown) => {
      crashCause = err instanceof Error ? err : new Error(String(err));
    });
    worker.on("exit", (code: number) => {
      this.#onExit(worker, code, crashCause);
    });
  }

  #onExit(worker: Worker, code: number, cause?: Error): void {
    // A stale generation exiting after a respawn must not touch current state.
    if (worker !== this.#worker) return;
    const target = this.#dataDir ?? "in-memory database";
    const error = new Error(
      `pglite worker (${target}) exited unexpectedly${
        cause ? `: ${cause.message}` : ` (exit code ${code})`
      }; in-flight queries were dropped`,
    );
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (this.#closed) return;

    this.#consecutiveCrashes += 1;
    // A respawn against an in-memory target would silently come back empty.
    if (!this.#dataDir) {
      this.#failed = error;
      return;
    }
    if (this.#consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      this.#failed = new Error(
        `pglite worker (${target}) crashed ${this.#consecutiveCrashes} times in a row; giving up`,
        { cause },
      );
      console.error(this.#failed.message);
      return;
    }
    console.error(`${error.message}; respawning worker`);
    this.#spawn();
  }

  #call(op: string, payload: Record<string, unknown>): Promise<Any> {
    if (this.#failed) return Promise.reject(this.#failed);
    if (this.#closed) {
      return Promise.reject(new Error("worker pglite client is closed"));
    }
    const id = this.#seq++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, op, ...payload });
    });
  }

  /**
   * Query options can't cross the thread boundary as-is: drizzle passes
   * per-OID parser FUNCTIONS (all identity). Send the OID list instead;
   * the worker rebuilds identity parsers on its side.
   */
  static sanitizeOptions(options?: Record<string, unknown>): {
    options?: Record<string, unknown>;
    parserOids?: string[];
  } {
    if (!options) return {};
    const { parsers, ...rest } = options as {
      parsers?: Record<string, unknown>;
    };
    return {
      options: rest,
      parserOids: parsers ? Object.keys(parsers) : undefined,
    };
  }

  query(sql: string, params?: Any[], options?: Record<string, unknown>) {
    return this.#call("query", {
      sql,
      params,
      ...WorkerPgliteClient.sanitizeOptions(options),
    });
  }

  exec(sql: string) {
    return this.#call("exec", { sql });
  }

  async transaction<T>(cb: (tx: Any) => Promise<T>): Promise<T> {
    const txId = this.#txSeq++;
    await this.#call("txBegin", { txId });
    const txProxy = {
      query: (sql: string, params?: Any[], options?: Record<string, unknown>) =>
        this.#call("txQuery", {
          txId,
          sql,
          params,
          ...WorkerPgliteClient.sanitizeOptions(options),
        }),
      rollback: () => this.#call("txRollback", { txId }),
    };
    try {
      const result = await cb(txProxy);
      await this.#call("txCommit", { txId });
      return result;
    } catch (error) {
      await this.#call("txRollback", { txId }).catch(() => {});
      throw error;
    }
  }

  /** The live worker thread — exposed so crash-path tests can kill it. */
  get thread(): Worker {
    return this.#worker;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // Ask for a graceful PGlite shutdown, but cap the wait: a wedged
    // worker would otherwise hang server shutdown, and terminate() below
    // is the backstop either way.
    const goodbye = this.#failed
      ? Promise.resolve()
      : Promise.race([
          this.#call("close", {}).catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 2000).unref()),
        ]);
    this.#closed = true;
    await goodbye;
    await this.#worker.terminate();
  }
}
