import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents, issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Read positions are minted with now(); keep writes apart so an event
 *  never ties with the position taken just before it. */
const settle = () => new Promise((r) => setTimeout(r, 5));

const SRC = "xv-src";
const DST = "xv-dst";

type Who = Record<string, string>;

describe("cross-reference visibility T-150", () => {
  let t: TestApp;
  let cookie: string;
  /** Reader of the target project only — cannot see where the ref came from. */
  let outsider: Who;
  /** Reader of both, so every part of the reference is legible. */
  let insider: Who;
  let target = 0;
  let sourceIssue = 0;
  const headers = () => ({ "content-type": "application/json", cookie });

  const get = async (path: string, who: Who) => {
    const res = await t.app.request(`/api${path}`, { headers: who });
    expect(res.status).toBe(200);
    return json(res);
  };

  const createIssue = async (slug: string, title: string, body = "") => {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const timeline = (who: Who, qs = "") =>
    get(`/projects/${DST}/issues/${target}/timeline?limit=100${qs}`, who);

  const rowOf = async (who: Who) => {
    const page = await get(`/projects/${DST}/issues?limit=100`, who);
    return page.items.find((i: { number: number }) => i.number === target);
  };

  const inboxRow = async (who: Who) => {
    const page = await get("/me/inbox?limit=100", who);
    return page.items.find(
      (i: { number: number; project: { slug: string } }) =>
        i.project.slug === DST && i.number === target,
    );
  };

  const markRead = async (who: Who) => {
    await settle();
    const res = await t.app.request(
      `/api/projects/${DST}/issues/${target}/read`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...who },
        body: "{}",
      },
    );
    expect(res.status).toBe(204);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [SRC, DST]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: `Visibility ${slug}` }),
      });
      expect(res.status).toBe(201);
    }
    const bob = await addUserWithToken(t.ctx, "xv-outsider");
    const carol = await addUserWithToken(t.ctx, "xv-insider");
    outsider = bob.headers;
    insider = carol.headers;
    for (const [user, slugs] of [
      [bob, [DST]],
      [carol, [SRC, DST]],
    ] as const) {
      for (const slug of slugs) {
        const res = await t.app.request(
          `/api/projects/${slug}/members/${user.user.id}`,
          {
            method: "PUT",
            headers: headers(),
            body: JSON.stringify({ role: "reader" }),
          },
        );
        expect(res.status).toBe(204);
      }
    }

    target = await createIssue(DST, "the referenced card");
    // Both readers open the card before the reference lands, so anything
    // unread afterwards is the cross-reference and nothing else.
    for (const who of [outsider, insider]) {
      await rowOf(who);
      await inboxRow(who);
      await markRead(who);
    }
    await settle();
    sourceIssue = await createIssue(
      SRC,
      "the source",
      `fixes ${DST}#${target}`,
    );
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("shows the event to a reader of both projects", async () => {
    const page = await timeline(insider);
    const events = page.items.filter(
      (i: { event_type?: string }) => i.event_type === "cross_referenced",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      by_project: SRC,
      by_issue: sourceIssue,
    });
  });

  it("hides it from a reader of the target alone, count included", async () => {
    const mine = await timeline(outsider);
    expect(
      mine.items.filter(
        (i: { event_type?: string }) => i.event_type === "cross_referenced",
      ),
    ).toEqual([]);
    expect(mine.total_count).toBe(mine.items.length);

    const theirs = await timeline(insider);
    expect(theirs.total_count).toBe(mine.total_count + 1);
  });

  it("pages past the hidden event without repeating or skipping", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const qs: string = cursor === null ? "" : `&after=${cursor}`;
      const res = await get(
        `/projects/${DST}/issues/${target}/timeline?limit=1${qs}`,
        outsider,
      );
      for (const item of res.items) seen.push(item.id);
      cursor = res.next_cursor;
      if (!res.has_more) break;
    }
    const full = await timeline(outsider);
    expect(seen).toEqual(full.items.map((i: { id: number }) => i.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("leaves no ghost unread for the reader who cannot see the source", async () => {
    const row = await rowOf(outsider);
    expect(row.unread).toBe(false);
    expect(row.unread_comments).toBe(0);
    expect(await inboxRow(outsider)).toBeUndefined();
  });

  it("lights a weak unread for the reader who can, without counting it", async () => {
    const row = await rowOf(insider);
    expect(row.unread).toBe(true);
    // T-77/T-151: events mark unread but never join the comment count.
    expect(row.unread_comments).toBe(0);
    expect(await inboxRow(insider)).toBeDefined();
  });

  it("drops the row entirely when weak unread is switched off", async () => {
    const res = await t.app.request("/api/me/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...insider },
      body: JSON.stringify({ show_weak_unread: false }),
    });
    expect(res.status).toBe(200);
    try {
      expect(await inboxRow(insider)).toBeUndefined();
    } finally {
      await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...insider },
        body: JSON.stringify({ show_weak_unread: true }),
      });
    }
  });

  it("filters the activity streams by the same rule", async () => {
    const crossTypes = (page: { items: Array<{ event_type?: string }> }) =>
      page.items.filter((i) => i.event_type === "cross_referenced");
    expect(
      crossTypes(await get(`/projects/${DST}/activity?limit=100`, outsider)),
    ).toEqual([]);
    expect(
      crossTypes(await get(`/projects/${DST}/activity?limit=100`, insider)),
    ).toHaveLength(1);
    expect(
      crossTypes(await get(`/activity?projects=${DST}&limit=100`, outsider)),
    ).toEqual([]);
  });

  it("does not duplicate an event that predates by_project_id", async () => {
    // Old rows carry only a slug. Deduplication keyed on the id alone would
    // never match them, and `recordCrossReferences` replays the whole set on
    // every edit — so each edit of the source would add another row here.
    const legacy = await createIssue(DST, "referenced the old way");
    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: (await get(`/projects/${DST}`, { cookie })).id,
        slug: DST,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.number, legacy));
    const srcProject = await get(`/projects/${SRC}`, { cookie });
    const oldSource = await createIssue(SRC, "old-style source");
    await db.insert(issueEvents).values({
      projectId: (await get(`/projects/${DST}`, { cookie })).id,
      issueId: issue?.id as number,
      actorId: 1,
      type: "cross_referenced",
      payload: { by_project: SRC, by_issue: oldSource },
    });
    void srcProject;

    const before = await get(
      `/projects/${DST}/issues/${legacy}/timeline?limit=100`,
      { cookie },
    );
    const countCross = (page: { items: Array<{ event_type?: string }> }) =>
      page.items.filter((i) => i.event_type === "cross_referenced").length;
    expect(countCross(before)).toBe(1);

    const res = await t.app.request(
      `/api/projects/${SRC}/issues/${oldSource}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ body: `still fixes ${DST}#${legacy}` }),
      },
    );
    expect(res.status).toBe(200);
    await settle();

    const after = await get(
      `/projects/${DST}/issues/${legacy}/timeline?limit=100`,
      { cookie },
    );
    expect(countCross(after)).toBe(1);
  });

  it("keeps a move-rewritten row visible, with its far side blanked", async () => {
    // Hiding it instead would delete a line the reader could see yesterday,
    // over a change to a card they may not even be able to reach.
    const card = await createIssue(DST, "referenced by something that moved");
    const dst = await get(`/projects/${DST}`, { cookie });
    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: dst.id,
        slug: DST,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.number, card));
    await db.insert(issueEvents).values({
      projectId: dst.id,
      issueId: issue?.id as number,
      actorId: 1,
      type: "cross_referenced",
      // A project the outsider cannot read, on a row a move rewrote.
      payload: {
        by_project: "somewhere-unreadable",
        by_project_id: 987654,
        by_issue: 7,
        by_moved: true,
      },
    });

    const page = await get(
      `/projects/${DST}/issues/${card}/timeline?limit=100`,
      outsider,
    );
    const row = page.items.find(
      (i: { event_type?: string }) => i.event_type === "cross_referenced",
    );
    expect(row).toBeDefined();
    expect(row.payload).toMatchObject({
      by_project: null,
      by_project_id: null,
      by_issue: null,
    });
  });
});
