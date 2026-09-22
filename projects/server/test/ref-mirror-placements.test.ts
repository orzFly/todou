import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, refPrefixes } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { syncRefPrefixMirror } from "../src/services/reference-directory.ts";
import { countStatements, makeTestApp, type TestApp } from "./helpers.ts";

/**
 * The destructive and multi-instance cases for the startup mirror sweep live
 * here rather than in reference-directory.test.ts: they need their own apps,
 * and that file's own subject (the directory payload) is about to be rewritten
 * elsewhere.
 */
describe("mirror sweep on a colocated deployment (shared placement)", () => {
  let t: TestApp;
  let cookie: string;

  const create = (n: number) =>
    t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        slug: `rm-s${n}`,
        name: `Mirror shared ${n}`,
        ref_prefix: `S${n}`,
      }),
    });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("costs the same one statement at four projects as at eight", async () => {
    for (let n = 1; n <= 4; n++) expect((await create(n)).status).toBe(201);
    const four = await countStatements(t, async () => {
      await syncRefPrefixMirror(t.ctx);
    });
    for (let n = 5; n <= 8; n++) expect((await create(n)).status).toBe(201);
    const eight = await countStatements(t, async () => {
      await syncRefPrefixMirror(t.ctx);
    });

    expect(eight.total).toBe(four.total);
    // The one statement left is the `select … from projects` that decides
    // which projects the sweep still owes anything; every colocated project
    // is then skipped without a query of its own.
    expect(four.total).toBe(1);
    // Read back from the router rather than hard-coded: under shared
    // placement the projects' own url IS the system one, which is also why
    // this placement cannot attribute statements per bucket.
    expect(Object.keys(eight.byUrl)).toEqual([t.ctx.router.systemHandle().url]);
  });

  // Last in this describe because it leaves the mirror short a row on
  // purpose. It pins behaviour this card deliberately removed: a colocated
  // deployment has no repair path any more, because the only way to get a
  // gap is a write that rolled back.
  it("no longer repairs a gap punched into a colocated mirror", async () => {
    const system = t.ctx.router.system();
    const before = await system.select().from(refPrefixes);
    const victim = before.find((row) => row.prefix === "S1");
    if (!victim) throw new Error("expected a mirrored S1 row");
    await system.delete(refPrefixes).where(eq(refPrefixes.id, victim.id));

    expect(await syncRefPrefixMirror(t.ctx)).toBe(0);
    expect(await system.select().from(refPrefixes)).toHaveLength(
      before.length - 1,
    );
  });
});

/**
 * Regression watchdog — green on the parent commit as well. Across two
 * databases there is no transaction to lean on, so the sweep stays the only
 * repair path, and this is the one case guarding its algorithm: read the
 * source, diff by key, insert what is missing, delete nothing, converge.
 */
describe("mirror repair across databases (dedicated placement)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        slug: "rm-d1",
        name: "Mirror dedicated",
        ref_prefix: "RA",
      }),
    });
    expect(res.status).toBe(201);
    // A second history row, so the sweep has to pick the missing one out
    // instead of copying a one-row history wholesale.
    const put = await t.app.request("/api/projects/rm-d1/references/format", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ prefix: "RB" }),
    });
    expect(put.status).toBe(200);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("re-copies a missing mirror row and stays idempotent", async () => {
    const system = t.ctx.router.system();
    const before = await system.select().from(refPrefixes);
    expect(before).toHaveLength(2);
    const victim = before.find((row) => row.prefix === "RB");
    if (!victim) throw new Error("expected a mirrored RB row");
    await system.delete(refPrefixes).where(eq(refPrefixes.id, victim.id));

    expect(await syncRefPrefixMirror(t.ctx)).toBe(1);
    expect(await syncRefPrefixMirror(t.ctx)).toBe(0);
    const after = await system.select().from(refPrefixes);
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.prefix).sort()).toEqual(["RA", "RB"]);
  });
});

describe("a project pinned out of the system database is still swept", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const n of [1, 2]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          slug: `rm-p${n}`,
          name: `Mirror pinned ${n}`,
          ref_prefix: `P${n}`,
        }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  // What this pins is the skip predicate, not a state the API can reach:
  // under shared placement `databaseUrlToPin` never writes a pin, because
  // resolving any slug gives the same url and the rename it guards against
  // therefore changes nothing. The row is written here by hand for that
  // reason — the deployment-wide clause of the skip is what would otherwise
  // drop this project, and a dropped project is one the sweep never repairs.
  it("keeps querying a project whose row names its own database", async () => {
    const system = t.ctx.router.system();
    const pinnedUrl = `pglite://memory/pinned-${randomUUID()}`;
    await system
      .update(projects)
      .set({ databaseUrl: pinnedUrl })
      .where(eq(projects.slug, "rm-p1"));
    const pinned = (
      await system.select().from(projects).where(eq(projects.slug, "rm-p1"))
    )[0];
    if (!pinned) throw new Error("expected rm-p1");
    // Opened ahead of the window: the first open of a fresh database runs the
    // project-tier migration, whose statements go through the same tap.
    await t.ctx.router.forProject(routeInfoOf(pinned));

    const log = await countStatements(t, async () => {
      await syncRefPrefixMirror(t.ctx);
    });

    // One `select … from projects`, plus the pinned project's own two: its
    // history in its own database and its mirror rows in the system one.
    expect(log.total).toBe(3);
    expect(Object.keys(log.byUrl).sort()).toEqual(
      [
        t.ctx.router.systemHandle().url,
        t.ctx.router.resolveProjectUrl(routeInfoOf(pinned)),
      ].sort(),
    );
  });
});
