import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueBlocks } from "../src/db/system-schema.ts";
import { repairBlocks } from "../src/services/blocks.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const PA = "xblock-a";
const PB = "xblock-b";

/**
 * Everything here runs under `dedicated` placement, where the two projects
 * really are two databases — which is the only way the cross-database half
 * of this feature is exercised at all. Under `shared` these same calls would
 * pass without ever leaving one connection.
 */
describe("block edges across databases T-377", () => {
  let t: TestApp;
  let cookie: string;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  async function createIssue(slug: string, title: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  const block = async (
    slug: string,
    number: number,
    direction: "blocked-by" | "blocks",
    ref: string,
  ): Promise<Response> =>
    t.app.request(`/api/projects/${slug}/issues/${number}/${direction}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ref }),
    });

  async function issue(slug: string, number: number) {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  async function statusNamed(slug: string, name: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/statuses`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const row = (await json(res)).find(
      (s: { name: string }) => s.name === name,
    );
    expect(row, `${name} in ${slug}`).toBeDefined();
    return row.id as number;
  }

  async function setStatus(slug: string, number: number, name: string) {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ status_id: await statusNamed(slug, name) }),
    });
    expect(res.status).toBe(200);
  }

  async function timelineTypes(slug: string, number: number) {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/timeline?limit=100`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return (await json(res)).items
      .filter((i: { type: string }) => i.type === "event")
      .map((i: { event_type: string }) => i.event_type) as string[];
  }

  async function setClearLine(slug: string, name: string | null) {
    const res = await t.app.request(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        block_clear_status_id:
          name === null ? null : await statusNamed(slug, name),
      }),
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    cookie = await t.login();
    for (const [slug, name] of [
      [PA, "Cross A"],
      [PB, "Cross B"],
    ] as const) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name }),
      });
      expect(res.status).toBe(201);
    }
    bob = await addUserWithToken(t.ctx, "xblock-bob");
    for (const slug of [PA, PB]) {
      expect(
        (
          await t.app.request(`/api/projects/${slug}/members/${bob.user.id}`, {
            method: "PUT",
            headers: headers(),
            body: JSON.stringify({ role: "writer" }),
          })
        ).status,
      ).toBe(204);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("lands the declaration on both cards, in both databases", async () => {
    const blocked = await createIssue(PA, "a waits for b");
    const blocker = await createIssue(PB, "b goes first");
    const res = await block(PA, blocked, "blocked-by", `${PB}#${blocker}`);
    expect(res.status).toBe(200);
    expect((await json(res)).blocked_by[0]).toMatchObject({
      project: PB,
      number: blocker,
      ref: `#${blocker}`,
      hidden: false,
    });

    expect(await timelineTypes(PA, blocked)).toContain("block_added");
    expect(await timelineTypes(PB, blocker)).toContain("block_added");
    expect((await issue(PB, blocker)).blocks[0]).toMatchObject({
      project: PA,
      number: blocked,
    });
  });

  it("carries the clearing into the other database, and takes it back", async () => {
    await setClearLine(PB, "Shipped");
    const blocked = await createIssue(PA, "waits on another db");
    const blocker = await createIssue(PB, "ships in another db");
    expect(
      (await block(PA, blocked, "blocked-by", `${PB}#${blocker}`)).status,
    ).toBe(200);

    await setStatus(PB, blocker, "Shipped");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();
    expect(await timelineTypes(PA, blocked)).toContain("block_cleared");
    // Nothing lands on the blocker: the clearing is news for whoever waits.
    expect(await timelineTypes(PB, blocker)).not.toContain("block_cleared");

    await setStatus(PB, blocker, "In Progress");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();
    expect(await timelineTypes(PA, blocked)).toContain("block_reblocked");
  });

  it("suspends across the boundary when the blocker is binned", async () => {
    await setClearLine(PB, "Shipped");
    const blocked = await createIssue(PA, "blocker binned elsewhere");
    const blocker = await createIssue(PB, "binned elsewhere");
    await block(PA, blocked, "blocked-by", `${PB}#${blocker}`);

    expect(
      (
        await t.app.request(`/api/projects/${PB}/issues/${blocker}`, {
          method: "DELETE",
          headers: headers(),
        })
      ).status,
    ).toBe(204);
    const held = (await issue(PA, blocked)).blocked_by[0];
    expect(held.cleared_at).toBeNull();
    expect(held.blocker_deleted).toBe(true);
    expect(await timelineTypes(PA, blocked)).not.toContain("block_cleared");

    expect(
      (
        await t.app.request(`/api/projects/${PB}/issues/${blocker}/restore`, {
          method: "POST",
          headers: headers(),
        })
      ).status,
    ).toBe(200);
    expect((await issue(PA, blocked)).blocked_by[0].blocker_deleted).toBe(
      false,
    );
  });

  it("recomputes edges into another database when the line moves", async () => {
    await setClearLine(PB, "Shipped");
    const blocked = await createIssue(PA, "line moves in the other db");
    const blocker = await createIssue(PB, "sits at ready to ship");
    await block(PA, blocked, "blocked-by", `${PB}#${blocker}`);
    await setStatus(PB, blocker, "Ready to Ship");
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();

    const project = await setClearLine(PB, "Ready to Ship");
    expect(project.block_clear_status_id).toBe(
      await statusNamed(PB, "Ready to Ship"),
    );
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();
    expect(await timelineTypes(PA, blocked)).toContain("block_cleared");
    await setClearLine(PB, "Shipped");
  });

  it("repairs a verdict that drifted across the boundary", async () => {
    await setClearLine(PB, "Shipped");
    const blocked = await createIssue(PA, "drifted across");
    const blocker = await createIssue(PB, "shipped across");
    await block(PA, blocked, "blocked-by", `${PB}#${blocker}`);
    await setStatus(PB, blocker, "Shipped");
    const edgeId = (await issue(PA, blocked)).blocked_by[0].edge_id as number;

    await t.ctx.router
      .system()
      .update(issueBlocks)
      .set({ clearedAt: null, clearedNotifiedAt: null })
      .where(eq(issueBlocks.id, edgeId));
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).toBeNull();

    expect((await repairBlocks(t.ctx)).recomputed).toBeGreaterThan(0);
    expect((await issue(PA, blocked)).blocked_by[0].cleared_at).not.toBeNull();
    expect(
      (await timelineTypes(PA, blocked)).filter((e) => e === "block_cleared"),
    ).toHaveLength(2);
  });

  it("rewrites both ends when a card moves between databases", async () => {
    const blocked = await createIssue(PA, "moving across databases");
    const blocker = await createIssue(PB, "stays in b");
    await block(PA, blocked, "blocked-by", `${PB}#${blocker}`);

    const res = await t.app.request(
      `/api/projects/${PA}/issues/${blocked}/move`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ to_project: PB }),
      },
    );
    expect(res.status).toBe(200);
    const landed = (await json(res)).moved_to.number as number;

    const moved = await issue(PB, landed);
    expect(moved.blocked_by).toHaveLength(1);
    expect(moved.blocked_by[0]).toMatchObject({
      project: PB,
      number: blocker,
    });
    expect((await issue(PB, blocker)).blocks[0]).toMatchObject({
      project: PB,
      number: landed,
    });
    // The old address holds a tombstone, and no edge points at it any more.
    const stale = await t.ctx.router
      .system()
      .select()
      .from(issueBlocks)
      .where(eq(issueBlocks.blockedNumber, blocked));
    expect(
      stale.filter((row) => row.blockedProjectId !== row.blockerProjectId),
    ).toEqual([]);
  });
});
