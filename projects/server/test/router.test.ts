import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBuiltinUser } from "../src/bootstrap.ts";
import { statuses } from "../src/db/project-schema.ts";
import type { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import { makeRouter } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

const openRouters: DbRouter[] = [];

async function open(...args: Parameters<typeof makeRouter>) {
  const made = await makeRouter(...args);
  openRouters.push(made.router);
  return made;
}

afterEach(async () => {
  for (const router of openRouters.splice(0)) {
    await router.close();
  }
});

const project = (id: number, databaseUrl: string | null = null) => ({
  id,
  slug: `p${id}`,
  database_url: databaseUrl,
});

async function insertStatus(router: DbRouter, projectId: number) {
  const db = await router.provision(project(projectId));
  await db.insert(statuses).values({
    projectId,
    name: `s-${projectId}`,
    category: "open",
    position: 0,
  });
  return db;
}

async function statusCount(router: DbRouter, projectId: number) {
  const db = await router.forProject(project(projectId));
  return (await db.select().from(statuses)).length;
}

const routeOf = (p: ReturnType<typeof project>) => p;

describe("system tier", () => {
  it("migrates and serves the system schema", async () => {
    const { router } = await open("shared");
    await ensureBuiltinUser(router.system());
    const rows = await router.system().select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.login).toBe("user");
    expect(rows[0]?.isInstanceAdmin).toBe(true);
    // Idempotent: a second call must not duplicate the account.
    await ensureBuiltinUser(router.system());
    expect(await router.system().select().from(users)).toHaveLength(1);
  });
});

describe("shared placement", () => {
  it("routes project data into the system database", async () => {
    const { config, router } = await open("shared");
    expect(router.resolveProjectUrl(project(1))).toBe(config.database.system);
    await insertStatus(router, 1);
    expect(await statusCount(router, 1)).toBe(1);
    expect(router.openHandleCount()).toBe(0);
  });
});

describe("dedicated placement", () => {
  it("gives each project an isolated database", async () => {
    const { router } = await open("dedicated");
    await insertStatus(router, 1);
    const db2 = await router.provision(project(2));
    expect((await db2.select().from(statuses)).length).toBe(0);
    expect(await statusCount(router, 1)).toBe(1);
    expect(router.openHandleCount()).toBe(2);
  });

  it("shares one handle when a user expression maps projects together", async () => {
    const { router } = await open("dedicated-bucketed");
    // ids 1 and 3 land in bucket 1; id 2 lands in bucket 0.
    await insertStatus(router, 1);
    await insertStatus(router, 3);
    await insertStatus(router, 2);
    expect(router.openHandleCount()).toBe(2);
    const bucket1 = await router.forProject(project(1));
    expect((await bucket1.select().from(statuses)).length).toBe(2);
  });

  it("prefers the per-project registry override", async () => {
    const { router } = await open("dedicated");
    const override = "pglite://memory/override-target";
    expect(router.resolveProjectUrl(project(9, override))).toBe(override);
  });

  it("evicts file-backed handles beyond max_open and reopens them", async () => {
    const dir = testTmpDir("todou-router-");
    const { router } = await open("dedicated", {
      maxOpen: 1,
      urlTemplate: `pglite://${dir}/p\${project.id}`,
    });
    await insertStatus(router, 1);
    await insertStatus(router, 2);
    expect(router.openHandleCount()).toBe(1);
    // Project 1 was evicted; reopening reads persisted data back.
    expect(await statusCount(router, 1)).toBe(1);
  });
});

// These four fail on the parent commit only because the method is absent
// (TS2339 at typecheck, TypeError at runtime) — none of them is a red that
// measures a cost this card removes. They pin the API contract instead, so
// the ten sections building on `perDatabase` inherit a checked shape.
describe("perDatabase", () => {
  it("groups by resolved url, in first-appearance order", async () => {
    const { router } = await open("dedicated-bucketed");
    const groups = await router.perDatabase(
      [project(1), project(2), project(3)],
      routeOf,
      async (_db, group) => group.map((p) => p.id),
    );
    expect(groups).toEqual([[1, 3], [2]]);
    // Cross-check the hard-coded buckets against the router itself, so the
    // case still states the contract ("group by RESOLVED url") and not just
    // today's `${project.id % 2}` template.
    const urls = [1, 2, 3].map((id) => router.resolveProjectUrl(project(id)));
    expect(urls[0]).toBe(urls[2]);
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("opens a group's handle inside its task, not up front", async () => {
    const dir = testTmpDir("todou-per-database-");
    const { router } = await open("dedicated", {
      maxOpen: 1,
      urlTemplate: `pglite://${dir}/p\${project.id}`,
    });
    for (const id of [1, 2, 3]) await insertStatus(router, id);

    // File-backed on purpose: `#evictIfNeeded` puts `pglite://memory` handles
    // straight back, so an in-memory fixture cannot tell "opened lazily" from
    // "opened all three up front". With max_open=1, opening up front would
    // close the first two handles before their queries run.
    const names = await router.perDatabase(
      [project(1), project(2), project(3)],
      routeOf,
      async (db) => (await db.select().from(statuses)).map((s) => s.name),
    );
    expect(names).toEqual([["s-1"], ["s-2"], ["s-3"]]);
  });

  it("keeps at most max_open groups in flight, through public forProject", async () => {
    const { router } = await open("dedicated", { maxOpen: 2 });
    // Borrow the grouping without really opening four project databases: one
    // openDb+migrate("project") costs ~1.9s here, and the gate below needs
    // both callbacks to arrive in the same microtask batch, which a cold open
    // would break. Spying on `forProject` also pins the contract that
    // perDatabase goes through the public method: a body reaching for the
    // private `#handleForProject` would leave this spy uncalled.
    const forProject = vi
      .spyOn(router, "forProject")
      .mockImplementation(async () => router.system());
    let entered = 0;
    let live = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Only ever redeemed if the implementation is serial, in which case the
    // second callback never arrives to release the gate.
    const escapeHatch = setTimeout(release, 1000);
    escapeHatch.unref?.();
    await router.perDatabase(
      [project(1), project(2), project(3), project(4)],
      routeOf,
      async (db) => {
        live++;
        entered++;
        peak = Math.max(peak, live);
        if (entered === 2) release();
        await gate;
        await db.select().from(users);
        live--;
        return 1;
      },
    );
    clearTimeout(escapeHatch);
    expect(peak).toBe(2);
    expect(forProject).toHaveBeenCalledTimes(4);
  });

  it("folds a shared placement into one group and takes nothing empty", async () => {
    const { router } = await open("shared");
    expect(
      await router.perDatabase(
        [project(1), project(2)],
        routeOf,
        async (_db, group) => group.length,
      ),
    ).toEqual([2]);
    expect(router.openHandleCount()).toBe(0);
    expect(await router.perDatabase([], routeOf, async () => 1)).toEqual([]);
  });
});
