// Worker-thread host for one PGlite instance. The main thread talks to it
// through a tiny id-correlated message protocol (see worker-client.ts).
// Running each dedicated project database in its own worker lets queries
// for different projects execute on different cores — PGlite is WASM and
// otherwise burns main-thread CPU.
import { parentPort, workerData } from "node:worker_threads";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { PGLITE_EXTENSIONS } from "./pglite-extensions.ts";

type Request = {
  id: number;
  op:
    | "query"
    | "exec"
    | "txBegin"
    | "txQuery"
    | "txRollback"
    | "txCommit"
    | "close";
  txId?: number;
  sql?: string;
  // biome-ignore lint/suspicious/noExplicitAny: raw wire values
  params?: any[];
  options?: Record<string, unknown>;
  /** OIDs whose parser is identity (functions can't cross the boundary). */
  parserOids?: string[];
};

function rebuildOptions(msg: Request): Record<string, unknown> | undefined {
  if (!msg.options && !msg.parserOids) return undefined;
  return {
    ...msg.options,
    ...(msg.parserOids
      ? {
          parsers: Object.fromEntries(
            msg.parserOids.map((oid) => [oid, (value: unknown) => value]),
          ),
        }
      : {}),
  };
}

const port = parentPort;
if (!port) throw new Error("pglite-worker must run inside a worker thread");

const dataDir = (workerData as { dataDir?: string })?.dataDir;
const client = dataDir
  ? new PGlite(dataDir, { extensions: PGLITE_EXTENSIONS })
  : new PGlite({ extensions: PGLITE_EXTENSIONS });

type TxEntry = { tx: Transaction; finish: () => void };
const txs = new Map<number, TxEntry>();
/** Resolves when the underlying client.transaction() call has settled. */
const txSettled = new Map<number, Promise<void>>();

function reply(id: number, result: unknown) {
  port?.postMessage({ id, result });
}
function replyError(id: number, error: unknown) {
  port?.postMessage({
    id,
    error: error instanceof Error ? error.message : String(error),
  });
}

port.on("message", async (msg: Request) => {
  try {
    switch (msg.op) {
      case "query": {
        reply(
          msg.id,
          await client.query(
            msg.sql as string,
            msg.params,
            rebuildOptions(msg),
          ),
        );
        break;
      }
      case "exec": {
        reply(msg.id, await client.exec(msg.sql as string));
        break;
      }
      case "txBegin": {
        const txId = msg.txId as number;
        // Hold the PGlite transaction open until commit/rollback arrives;
        // the begin request is answered once the tx handle is captured.
        const settled = client
          .transaction(async (tx) => {
            await new Promise<void>((resolve) => {
              txs.set(txId, { tx, finish: resolve });
              reply(msg.id, null);
            });
          })
          .then(
            () => undefined,
            () => undefined,
          );
        txSettled.set(txId, settled);
        break;
      }
      case "txQuery": {
        const entry = txs.get(msg.txId as number);
        if (!entry) throw new Error("unknown transaction");
        reply(
          msg.id,
          await entry.tx.query(
            msg.sql as string,
            msg.params,
            rebuildOptions(msg),
          ),
        );
        break;
      }
      case "txCommit": {
        const txId = msg.txId as number;
        const entry = txs.get(txId);
        if (!entry) throw new Error("unknown transaction");
        txs.delete(txId);
        entry.finish();
        await txSettled.get(txId);
        txSettled.delete(txId);
        reply(msg.id, null);
        break;
      }
      case "txRollback": {
        const txId = msg.txId as number;
        const entry = txs.get(txId);
        if (!entry) throw new Error("unknown transaction");
        txs.delete(txId);
        await entry.tx.rollback();
        entry.finish();
        await txSettled.get(txId);
        txSettled.delete(txId);
        reply(msg.id, null);
        break;
      }
      case "close": {
        await client.close();
        reply(msg.id, null);
        port.close();
        break;
      }
    }
  } catch (error) {
    replyError(msg.id, error);
  }
});
