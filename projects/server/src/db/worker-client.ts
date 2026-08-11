import { Worker } from "node:worker_threads";

// biome-ignore lint/suspicious/noExplicitAny: raw wire values
type Any = any;

type Pending = { resolve: (v: Any) => void; reject: (e: Error) => void };

/**
 * Main-thread proxy that satisfies the query surface drizzle-orm/pglite
 * uses (query / exec / transaction) while the real PGlite instance runs in
 * a worker thread. EXPERIMENTAL — enabled by
 * `database.projects.workers = true`.
 */
export class WorkerPgliteClient {
  #worker: Worker;
  #pending = new Map<number, Pending>();
  #seq = 0;
  #txSeq = 0;

  constructor(dataDir?: string) {
    this.#worker = new Worker(new URL("./pglite-worker.ts", import.meta.url), {
      workerData: { dataDir },
    });
    this.#worker.on(
      "message",
      (msg: { id: number; result?: Any; error?: string }) => {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        if (msg.error !== undefined) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      },
    );
    this.#worker.on("error", (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  #call(op: string, payload: Record<string, unknown>): Promise<Any> {
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

  async close(): Promise<void> {
    await this.#call("close", {}).catch(() => {});
    await this.#worker.terminate();
  }
}
