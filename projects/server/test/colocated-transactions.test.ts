import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { refFormats, statuses } from "../src/db/project-schema.ts";
import { projects, refPrefixes, slugHistory } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { syncRefPrefixMirror } from "../src/services/reference-directory.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

/**
 * Fault injection through the query tap: the hook runs before drizzle
 * executes the statement, so throwing from it aborts exactly the write whose
 * text matches. It rests on drizzle calling `logQuery` ahead of execution, so
 * a drizzle upgrade can quietly stop it from firing — which is why every case
 * below also counts the rows that survived instead of trusting the status
 * code alone.
 *
 * One shot, and cleared by the hook itself: the repair path this file then
 * exercises writes `insert into "ref_prefixes"` too, so a hook left armed
 * would take down a later, unrelated-looking assertion.
 */
let armed: RegExp | null = null;
const injector = {
  onQuery: (sql: string) => {
    if (armed?.test(sql)) {
      armed = null;
      throw new Error("injected");
    }
  },
};

const MIRROR_INSERT = /insert into "ref_prefixes"/;

afterEach(() => {
  armed = null;
  vi.restoreAllMocks();
});

describe("colocated writes commit or roll back together (shared placement)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  const create = (slug: string, refPrefix?: string) =>
    t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        slug,
        name: `Colocated ${slug}`,
        ...(refPrefix === undefined ? {} : { ref_prefix: refPrefix }),
      }),
    });

  const statusCount = async () =>
    (await t.ctx.router.system().select().from(statuses)).length;

  const projectRow = async (slug: string) =>
    (
      await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
    )[0];

  beforeAll(async () => {
    t = await makeTestApp("shared", undefined, injector);
    cookie = await t.login();
    expect((await create("ct-a", "AA")).status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("leaves no history row behind when the mirror write fails", async () => {
    const project = await projectRow("ct-a");
    if (!project) throw new Error("expected ct-a");
    armed = MIRROR_INSERT;
    const res = await t.app.request("/api/projects/ct-a/references/format", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ prefix: "AB" }),
    });
    expect(res.status).toBe(500);

    const system = t.ctx.router.system();
    expect(
      await system
        .select()
        .from(refFormats)
        .where(eq(refFormats.projectId, project.id)),
    ).toHaveLength(1);
    expect(
      await system
        .select()
        .from(refPrefixes)
        .where(eq(refPrefixes.projectId, project.id)),
    ).toHaveLength(1);
    const config = await t.app.request("/api/projects/ct-a/references/config", {
      headers: headers(),
    });
    expect(
      ((await config.json()) as { format: { prefix: string } }).format.prefix,
    ).toBe("AA");
  });

  it("leaves no project rows behind when a create fails midway", async () => {
    const before = await statusCount();
    armed = MIRROR_INSERT;
    expect((await create("ct-b", "BB")).status).toBe(500);

    // Regression watchdogs, green on the parent commit too: the compensating
    // delete already removed the registry row, and slug_history follows it
    // through its ON DELETE cascade.
    expect(await projectRow("ct-b")).toBeUndefined();
    expect(
      await t.ctx.router
        .system()
        .select()
        .from(slugHistory)
        .where(eq(slugHistory.slug, "ct-b")),
    ).toEqual([]);
    // The red this section is named for: nothing in the project tier points
    // at the registry row, so the compensating delete used to leave the
    // canonical statuses behind as orphans.
    expect((await statusCount()) - before).toBe(0);
  });

  it("refuses to seed the project tier when the route says it moved", async () => {
    const before = await statusCount();
    vi.spyOn(t.ctx.router, "sharesSystemDatabase").mockReturnValue(false);
    expect((await create("ct-c")).status).toBe(500);
    expect(await projectRow("ct-c")).toBeUndefined();
    expect((await statusCount()) - before).toBe(0);
  });
});

/**
 * Regression watchdog for the half that did not change: across two databases
 * there is still no transaction, so the history row lands without its mirror
 * and the sweep is what closes the gap.
 */
describe("cross-database writes still half-land (dedicated placement)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("dedicated", undefined, injector);
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: "ct-x", name: "Colocated ct-x" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("keeps the history row and lets the sweep copy it later", async () => {
    const system = t.ctx.router.system();
    const project = (
      await system.select().from(projects).where(eq(projects.slug, "ct-x"))
    )[0];
    if (!project) throw new Error("expected ct-x");

    armed = MIRROR_INSERT;
    const res = await t.app.request("/api/projects/ct-x/references/format", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ prefix: "XX" }),
    });
    expect(res.status).toBe(500);

    const db = await t.ctx.router.forProject(routeInfoOf(project));
    expect(
      await db
        .select()
        .from(refFormats)
        .where(eq(refFormats.projectId, project.id)),
    ).toHaveLength(1);
    expect(
      await system
        .select()
        .from(refPrefixes)
        .where(eq(refPrefixes.projectId, project.id)),
    ).toHaveLength(0);

    expect(await syncRefPrefixMirror(t.ctx)).toBe(1);
    expect(await syncRefPrefixMirror(t.ctx)).toBe(0);
  });
});
