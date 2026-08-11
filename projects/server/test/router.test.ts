import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBuiltinUser } from "../src/bootstrap.ts";
import { statuses } from "../src/db/project-schema.ts";
import type { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import { makeRouter } from "./helpers.ts";

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
    const dir = mkdtempSync(join(tmpdir(), "todou-router-"));
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
