import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectMembers, projects } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * That membership writes really are serialized on the project row (T-340).
 *
 * The barrier has to come from outside the app. Two requests fired at it
 * together are put in order a layer above this code, so a test built that way
 * passes with the lock removed — it proves nothing. Here the test holds the
 * lock itself, in its own transaction, and asks whether the write waits.
 *
 * Needs a real server: PGlite is one embedded connection, so the holding
 * transaction would block the write whether or not it asked for the row.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server exec vitest run test/members-postgres.test.ts
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("membership writes serialize on the project", () => {
  let t: TestApp;
  // The database persists across runs; a unique suffix isolates each one.
  const tag = `mempg-${Date.now().toString(36)}`;

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  const sending = (headers: Record<string, string>) => ({
    "content-type": "application/json",
    ...headers,
  });

  it("waits while another transaction holds the project row", async () => {
    const alice = await addUserWithToken(t.ctx, `${tag}-alice`);
    const bob = await addUserWithToken(t.ctx, `${tag}-bob`);
    const slug = `${tag}-p`;

    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: sending(alice.headers),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    const projectId = (await json(created)).id as number;

    // Bob is already a member, so the write under test is an UPDATE of his
    // role. That matters: an INSERT into `project_members` takes a key-share
    // lock on the `projects` row it references, which the barrier below would
    // block all on its own — and the test would then pass with the lock
    // removed, proving nothing. An UPDATE that leaves `project_id` alone
    // touches no foreign key, so the only thing that can hold it up is the
    // lock this test is here to check.
    const joined = await t.app.request(
      `/api/projects/${slug}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: sending(alice.headers),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(joined.status).toBe(204);

    const system = t.ctx.router.system();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });

    const holder = system.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      acquired();
      await held;
    });
    await locked;

    let settled = false;
    const write = Promise.resolve(
      t.app.request(`/api/projects/${slug}/members/${bob.user.id}`, {
        method: "PUT",
        headers: sending(alice.headers),
        body: JSON.stringify({ role: "reader" }),
      }),
    ).then((res) => {
      settled = true;
      return res;
    });

    await new Promise((resolve) => setTimeout(resolve, 400));
    // The discriminating assertion. Without the `for update` in
    // `writeMembership` the write does not care that this transaction is
    // sitting on the row, and has long since finished by now.
    expect(settled).toBe(false);

    release();
    await holder;
    expect((await write).status).toBe(204);

    const rows = await system
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    expect(rows).toHaveLength(2);
  });

  it("clamps a machine that only became too high while the write waited", async () => {
    const alice = await addUserWithToken(t.ctx, `${tag}-l-alice`);
    const bob = await addUserWithToken(t.ctx, `${tag}-l-bob`);
    const bot = await addUserWithToken(t.ctx, `${tag}-l-bot`, {
      kind: "machine",
      ownerId: bob.user.id,
    });
    const slug = `${tag}-l`;

    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: sending(alice.headers),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    const projectId = (await json(created)).id as number;

    for (const [who, role] of [
      [bob.user.id, "admin"],
      // Below what bob is about to be demoted to, so it is not collateral
      // when the demotion is planned and never enters that set.
      [bot.user.id, "reader"],
    ] as const) {
      const res = await t.app.request(`/api/projects/${slug}/members/${who}`, {
        method: "PUT",
        headers: sending(alice.headers),
        body: JSON.stringify({ role }),
      });
      expect(res.status).toBe(204);
    }

    const system = t.ctx.router.system();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = system.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      acquired();
      await held;
    });
    await locked;

    const demote = t.app.request(
      `/api/projects/${slug}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: sending(alice.headers),
        body: JSON.stringify({ role: "reporter" }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Raised while the demotion waits — legal at this instant, because bob is
    // still admin. Written on this connection because the API would want the
    // same lock.
    await system
      .update(projectMembers)
      .set({ role: "admin" })
      .where(eq(projectMembers.userId, bot.user.id));

    release();
    await holder;
    expect((await demote).status).toBe(204);

    // Reading the collateral set before the lock misses this row entirely: it
    // was under the new role when the set was built, so no later check has
    // anything to judge, and the machine is left outranking its owner for
    // good.
    const rows = await system
      .select({ userId: projectMembers.userId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    const byUser = Object.fromEntries(rows.map((r) => [r.userId, r.role]));
    expect(byUser[bob.user.id]).toBe("reporter");
    expect(byUser[bot.user.id]).toBe("reporter");
  });

  it("does not put back a collateral row somebody removed meanwhile", async () => {
    const alice = await addUserWithToken(t.ctx, `${tag}-r-alice`);
    const bob = await addUserWithToken(t.ctx, `${tag}-r-bob`);
    const bot = await addUserWithToken(t.ctx, `${tag}-r-bot`, {
      kind: "machine",
      ownerId: bob.user.id,
    });
    const slug = `${tag}-r`;

    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: sending(alice.headers),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    const projectId = (await json(created)).id as number;

    for (const [who, role] of [
      [bob.user.id, "admin"],
      [bot.user.id, "admin"],
    ] as const) {
      const res = await t.app.request(`/api/projects/${slug}/members/${who}`, {
        method: "PUT",
        headers: sending(alice.headers),
        body: JSON.stringify({ role }),
      });
      expect(res.status).toBe(204);
    }

    const system = t.ctx.router.system();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = system.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("update");
      acquired();
      await held;
    });
    await locked;

    // Alice demotes bob. The plan is read now — it names the machine, which
    // is above bob's new role and has to come down with him — and then parks
    // on the lock this test is holding.
    const demote = t.app.request(
      `/api/projects/${slug}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: sending(alice.headers),
        body: JSON.stringify({ role: "reporter" }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Meanwhile the machine leaves the project. Done on this connection
    // rather than through the API, which would want the same lock.
    await system
      .delete(projectMembers)
      .where(eq(projectMembers.userId, bot.user.id));

    release();
    await holder;
    expect((await demote).status).toBe(204);

    // The clamp must not have recreated it. `onConflictDoUpdate` on a row
    // that is no longer there inserts, which would undo the removal in the
    // name of lowering a role.
    const rows = await system
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    expect(rows.map((r) => r.userId).sort()).toEqual(
      [alice.user.id, bob.user.id].sort(),
    );
  });
});
