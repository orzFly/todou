import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents } from "../src/db/project-schema.ts";
import { issueBlocks } from "../src/db/system-schema.ts";
import { getProjectByRef, routeInfoOf } from "../src/services/access.ts";
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

  it("re-decides the verdict against the destination's clear line", async () => {
    // The move carries the card to a project whose line says something else
    // about the same status: in A, `In Progress` is at or past `Todo` and
    // clears; in B there is no line, so only the closed category does. Both
    // premises of the old verdict are gone, and leaving it standing would
    // show the blocked card as free to start on.
    await setClearLine(PA, "Todo");
    await setClearLine(PB, null);
    const blocked = await createIssue(PB, "waits across the move");
    const blocker = await createIssue(PA, "moves to a stricter project");
    expect(
      (await block(PB, blocked, "blocked-by", `${PA}#${blocker}`)).status,
    ).toBe(200);

    await setStatus(PA, blocker, "In Progress");
    expect((await issue(PB, blocked)).blocked_by[0].cleared_at).not.toBeNull();

    const res = await t.app.request(
      `/api/projects/${PA}/issues/${blocker}/move`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ to_project: PB }),
      },
    );
    expect(res.status).toBe(200);

    const after = (await issue(PB, blocked)).blocked_by[0];
    expect(after.project).toBe(PB);
    expect(after.cleared_at).toBeNull();
    expect(await timelineTypes(PB, blocked)).toContain("block_reblocked");
    await setClearLine(PA, "Shipped");
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

  it("names block events in all three feeds after removal and deletion", async () => {
    const oldSlug = "xblock-legacy";
    const newSlug = "xblock-renamed";
    const createProject = async (slug: string, reclaim = false) => {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug, reclaim }),
      });
      expect(res.status).toBe(201);
    };
    const member = async (slug: string, userId: number) => {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${userId}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "reader" }),
        },
      );
      expect(res.status).toBe(204);
    };
    const types = "block_added,block_cleared,block_reblocked,block_removed";
    const eventTypes = [
      "block_added",
      "block_cleared",
      "block_reblocked",
      "block_removed",
    ];

    await createProject(oldSlug);
    await member(oldSlug, bob.user.id);
    const onlyA = await addUserWithToken(t.ctx, "xblock-only-a");
    await member(PA, onlyA.user.id);
    await setClearLine(oldSlug, "Shipped");
    const blocked = await createIssue(PA, "historical block events");
    const blocker = await createIssue(oldSlug, "historical prerequisite");
    const farProject = await getProjectByRef(t.ctx, oldSlug);
    const nearProject = await getProjectByRef(t.ctx, PA);
    const added = await block(
      PA,
      blocked,
      "blocked-by",
      `${oldSlug}#${blocker}`,
    );
    expect(added.status).toBe(200);
    const edgeId = (await json(added)).blocked_by[0].edge_id as number;
    await setStatus(oldSlug, blocker, "Shipped");
    await setStatus(oldSlug, blocker, "In Progress");
    const removed = await t.app.request(
      `/api/projects/${PA}/issues/${blocked}/blocked-by/${edgeId}`,
      { method: "DELETE", headers: headers() },
    );
    expect(removed.status).toBe(204);
    expect((await issue(PA, blocked)).blocked_by).toEqual([]);
    expect(
      await t.ctx.router
        .system()
        .select()
        .from(issueBlocks)
        .where(eq(issueBlocks.id, edgeId)),
    ).toEqual([]);

    const db = await t.ctx.router.forProject(routeInfoOf(nearProject));
    const ownerPage = async (limit = 100, after?: string) => {
      const qs = new URLSearchParams({ types, limit: String(limit) });
      if (after) qs.set("after", after);
      const res = await t.app.request(
        `/api/projects/${PA}/issues/${blocked}/timeline?${qs}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      return json(res);
    };
    const stored = await db
      .select({
        id: issueEvents.id,
        payload: issueEvents.payload,
      })
      .from(issueEvents)
      .where(eq(issueEvents.projectId, nearProject.id));
    const ownEvents = (await ownerPage()).items.filter(
      (item: { payload?: { edge_id?: number } }) =>
        item.payload?.edge_id === edgeId,
    );
    expect(
      ownEvents.map((event: { event_type: string }) => event.event_type),
    ).toEqual(eventTypes);
    // Simulate rows written by an older server that persisted the old slug.
    // The id, not this spelling, must govern what a reader sees.
    const injected = ownEvents.map(
      (event: { id: number; event_type: string }) => {
        const row = stored.find((candidate) => candidate.id === event.id);
        expect(row).toBeDefined();
        const key =
          event.event_type === "block_added" ||
          event.event_type === "block_removed"
            ? "other_project"
            : "blocker_project";
        return {
          id: event.id,
          payload: {
            ...(row?.payload as Record<string, unknown>),
            [key]: oldSlug,
          },
        };
      },
    );
    for (const row of injected) {
      await db
        .update(issueEvents)
        .set({ payload: row.payload })
        .where(eq(issueEvents.id, row.id));
    }

    const rename = await t.app.request(`/api/projects/${oldSlug}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ slug: newSlug }),
    });
    expect(rename.status).toBe(200);
    expect((await json(rename)).id).toBe(farProject.id);
    await createProject(oldSlug, true);
    await member(oldSlug, onlyA.user.id);
    const reused = await getProjectByRef(t.ctx, oldSlug);
    expect(reused.id).not.toBe(farProject.id);

    type BlockFeedEvent = {
      event_type: string;
      payload: Record<string, unknown>;
    };
    const readFeeds = async (
      who: Record<string, string>,
    ): Promise<BlockFeedEvent[][]> => {
      const timelineRes = await t.app.request(
        `/api/projects/${PA}/issues/${blocked}/timeline?limit=100&types=${types}`,
        { headers: who },
      );
      const activityRes = await t.app.request(
        `/api/projects/${PA}/activity?limit=100&types=${types}`,
        { headers: who },
      );
      // Watch only A: visibility of the other end must not depend on the watch set.
      const crossRes = await t.app.request(
        `/api/activity?projects=${PA}&limit=100&types=${types}`,
        { headers: who },
      );
      for (const res of [timelineRes, activityRes, crossRes]) {
        expect(res.status).toBe(200);
      }
      const pages = await Promise.all(
        [timelineRes, activityRes, crossRes].map(json),
      );
      expect(
        pages[2].items.every(
          (item: { project: string }) => item.project === PA,
        ),
      ).toBe(true);
      return pages.map((page, index) => {
        const matches = page.items.filter(
          (item: { payload?: { edge_id?: number }; issue_number?: number }) =>
            item.payload?.edge_id === edgeId &&
            (index === 0 || item.issue_number === blocked),
        );
        expect(
          matches.map((item: { event_type: string }) => item.event_type),
        ).toEqual(eventTypes);
        return matches;
      });
    };
    const assertNames = (feeds: BlockFeedEvent[][], visible: boolean) => {
      for (const events of feeds) {
        for (const event of events) {
          const addedOrRemoved =
            event.event_type === "block_added" ||
            event.event_type === "block_removed";
          const prefix = addedOrRemoved ? "other" : "blocker";
          expect(event.payload).toMatchObject({
            edge_id: edgeId,
            ...(addedOrRemoved ? { role: "blocked" } : {}),
            [`${prefix}_project_id`]: visible ? farProject.id : null,
            [`${prefix}_number`]: visible ? blocker : null,
            [`${prefix}_project`]: visible ? newSlug : null,
          });
        }
      }
    };
    assertNames(await readFeeds(bob.headers), true);
    // This reader can see A and the *new occupant* of the old slug, but not
    // the original project: a slug-based visibility check would leak it.
    assertNames(await readFeeds(onlyA.headers), false);
    const denied = await t.app.request(`/api/projects/${newSlug}/activity`, {
      headers: onlyA.headers,
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const rawAfterReads = await db
      .select({ id: issueEvents.id, payload: issueEvents.payload })
      .from(issueEvents)
      .where(eq(issueEvents.projectId, nearProject.id));
    for (const row of injected) {
      expect(
        rawAfterReads.find((event) => event.id === row.id)?.payload,
      ).toEqual(row.payload);
    }

    const before = await ownerPage(2);
    expect(before.total_count).toBe(4);
    expect(before.items).toHaveLength(2);
    const continuation = await ownerPage(2, before.next_cursor);
    expect(
      continuation.items.map((item: { event_type: string }) => item.event_type),
    ).toEqual(eventTypes.slice(2));
    expect(continuation.total_count).toBe(4);

    const deleted = await t.app.request(`/api/projects/${newSlug}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleted.status).toBe(204);
    assertNames(await readFeeds({ cookie }), false);
    const after = await ownerPage(2);
    expect(after.total_count).toBe(before.total_count);
    expect(after.items.map((item: { id: number }) => item.id)).toEqual(
      before.items.map((item: { id: number }) => item.id),
    );
    expect(after.next_cursor).toBe(before.next_cursor);
    const resumed = await ownerPage(2, before.next_cursor);
    expect(resumed.total_count).toBe(continuation.total_count);
    expect(resumed.items.map((item: { id: number }) => item.id)).toEqual(
      continuation.items.map((item: { id: number }) => item.id),
    );
    const rawAfterDeletion = await db
      .select({ id: issueEvents.id, payload: issueEvents.payload })
      .from(issueEvents)
      .where(eq(issueEvents.projectId, nearProject.id));
    for (const row of injected) {
      expect(
        rawAfterDeletion.find((event) => event.id === row.id)?.payload,
      ).toEqual(row.payload);
    }
  });
});
