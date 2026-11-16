import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingPrefixMirrors, projects } from "../src/db/system-schema.ts";
import {
  drainPendingMirrors,
  markPendingMirror,
} from "../src/services/pending-mirror.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { createTestDatabase, type TestDatabase } from "./postgres-database.ts";

/**
 * The claim UPDATE's mutual exclusion (T-511). PGlite has a single
 * connection, so the default suite cannot run two drainers at once and
 * therefore cannot see this property at all: there, the two calls simply
 * queue. Skipped unless TODOU_TEST_POSTGRES_URL points at a server, whose
 * role needs CREATEDB: the test makes a database of its own.
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("two drainers racing for the same marks", () => {
  let database: TestDatabase | undefined;
  let t: TestApp;
  let cookie: string;
  // A database of its own: drainPendingMirrors claims every due mark in the
  // table, and the assertion below counts them, so no other run or test file
  // may have left marks there.
  const slugs = [1, 2, 3, 4].map((n) => `ppm-${n}`);
  const ids: number[] = [];

  beforeAll(async () => {
    if (!PG_URL) throw new Error("TODOU_TEST_POSTGRES_URL is unset");
    database = await createTestDatabase(PG_URL, "pending_mirror");
    t = await makeTestApp("dedicated", { systemUrl: database.url });
    cookie = await t.login();
    for (const slug of slugs) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { id: number }).id);
    }
  });

  afterAll(async () => {
    try {
      // Either may be unset: beforeAll can fail before reaching it.
      await t?.cleanup();
    } finally {
      await database?.drop();
    }
  });

  it("claims every mark exactly once between them", async () => {
    const system = t.ctx.router.system();
    for (const id of ids) {
      const rows = await system
        .select()
        .from(projects)
        .where(eq(projects.id, id));
      const row = rows[0];
      if (!row) throw new Error(`no project ${id}`);
      await markPendingMirror(t.ctx, row);
    }
    const now = new Date();
    await system
      .update(pendingPrefixMirrors)
      .set({ nextAttemptAt: now, attempts: 0, verifiedGeneration: 0 });

    const [left, right] = await Promise.all([
      drainPendingMirrors(t.ctx, now),
      drainPendingMirrors(t.ctx, now),
    ]);

    expect(left.claimed + right.claimed).toBe(ids.length);
    expect(left.failed + right.failed).toBe(0);
  });
});
