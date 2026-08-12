import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerPgliteClient } from "../src/db/worker-client.ts";

/**
 * Crash policy of the worker-hosted PGlite client: in-flight requests
 * reject, file-backed databases come back on a respawned worker with
 * committed data intact, in-memory ones fail the handle, and a crash
 * loop gives up after three consecutive exits.
 */
describe("worker pglite crash handling", () => {
  const clients: WorkerPgliteClient[] = [];

  function open(dataDir?: string): WorkerPgliteClient {
    const client = new WorkerPgliteClient(dataDir);
    clients.push(client);
    return client;
  }

  function freshDir(): string {
    return join(mkdtempSync(join(tmpdir(), "todou-crash-")), "db");
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clients.splice(0)) {
      await client.close().catch(() => {});
    }
  });

  it("rejects in-flight queries and recovers committed data on a respawned worker", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = open(freshDir());
    await client.query("CREATE TABLE t (id int)");
    await client.query("INSERT INTO t VALUES (1)");

    // Long enough to still be executing when the kill lands.
    const inFlight = client.query(
      "SELECT count(*) FROM generate_series(1, 100000000)",
    );
    await client.thread.terminate();
    await expect(inFlight).rejects.toThrow(/exited unexpectedly/);

    const rows = (await client.query("SELECT count(*) AS n FROM t")) as {
      rows: Array<{ n: number | string }>;
    };
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("aborts a transaction cut down by a crash without committing it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = open(freshDir());
    await client.query("CREATE TABLE t (id int)");
    await client.query("INSERT INTO t VALUES (1)");

    // Depending on when the kill lands, the tx query either dies in flight
    // ("exited unexpectedly") or reaches the respawned worker, which has
    // no such transaction. Both abort the transaction.
    await expect(
      client.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (2)");
        await client.thread.terminate();
        await tx.query("SELECT 1");
      }),
    ).rejects.toThrow(/exited unexpectedly|unknown transaction/);

    const rows = (await client.query("SELECT count(*) AS n FROM t")) as {
      rows: Array<{ n: number | string }>;
    };
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("fails the handle instead of respawning an in-memory database", async () => {
    const client = open();
    await client.query("CREATE TABLE t (id int)");
    await client.thread.terminate();
    await expect(client.query("SELECT 1")).rejects.toThrow(
      /exited unexpectedly/,
    );
    // Still failed on the next call — no silently-empty respawn.
    await expect(client.query("SELECT 1")).rejects.toThrow(
      /exited unexpectedly/,
    );
  });

  it("stops respawning after three consecutive crashes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = open(freshDir());
    await client.query("SELECT 1");

    for (let i = 0; i < 3; i++) {
      await client.thread.terminate();
    }
    await expect(client.query("SELECT 1")).rejects.toThrow(
      /crashed 3 times in a row/,
    );
  });

  it("resets the crash counter once a respawned worker serves a reply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = open(freshDir());
    await client.query("SELECT 1");

    for (let i = 0; i < 2; i++) {
      await client.thread.terminate();
    }
    await client.query("SELECT 1"); // proves generation 3 works, resets counter

    for (let i = 0; i < 2; i++) {
      await client.thread.terminate();
    }
    // Would have exceeded the cap without the reset.
    const rows = (await client.query("SELECT 1 AS one")) as {
      rows: Array<{ one: number }>;
    };
    expect(rows.rows[0]?.one).toBe(1);
  });

  it("close() terminates for good instead of respawning", async () => {
    const client = open(freshDir());
    await client.query("SELECT 1");
    await client.close();
    // threadId is -1 once a worker has exited; a respawn would be live.
    expect(client.thread.threadId).toBe(-1);
    await expect(client.query("SELECT 1")).rejects.toThrow(/closed/);
  });
});
