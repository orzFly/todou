import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments, issueEvents } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Where a card has been does not change how text typed into it today is read
 * (T-266). A bare `#N` means a card in the project the author is looking at,
 * every time, and the links already in the text are answers resolved when
 * they were written rather than spellings to be re-read.
 *
 * This file used to lock the opposite rule — an edit anchored to whichever
 * project owned the card when the text was first written (T-231 §4.2). The
 * scenarios are the ones that made that rule necessary, kept here against
 * the answer that replaced it.
 *
 * No executor is involved: a hand-written `moved_in` event is all an
 * ownership interval is, which is exactly why arrivals live in the timeline
 * instead of in a column.
 */
describe.each(PLACEMENTS)("reference anchoring (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  const A = `origin-a-${placement}`;
  const B = `origin-b-${placement}`;
  let idA = 0;
  let idB = 0;

  const headers = () => ({ "content-type": "application/json", cookie });
  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body ? headers() : { cookie },
    });

  const dbOf = async (id: number, slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({ id, slug, databaseUrl: null } as Parameters<
        typeof routeInfoOf
      >[0]),
    );

  const createIssue = async (slug: string, title: string, body = "") => {
    const res = await req(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };

  /** A `moved_in` on a card in B, claiming it arrived from `from` at `at`. */
  const arrivedFrom = async (
    issueId: number,
    from: { id: number; slug: string; number: number },
    at: Date,
  ) => {
    const db = await dbOf(idB, B);
    await db.insert(issueEvents).values({
      projectId: idB,
      issueId,
      actorId: 1,
      type: "moved_in",
      createdAt: at,
      payload: {
        move_token: `tok-${at.getTime()}`,
        lineage: 1,
        from_project_id: from.id,
        from_project: from.slug,
        from_number: from.number,
      },
    });
  };

  const timelineOf = async (slug: string, number: number) =>
    json(await req(`/projects/${slug}/issues/${number}/timeline`));

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    for (const slug of [A, B]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      const project = (await json(res)) as { id: number };
      if (slug === A) idA = project.id;
      else idB = project.id;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("reads a bare ref typed now as this project's, whatever the card's history", async () => {
    const sameNumberInA = await createIssue(A, "the old numbering's card");
    // A card in B with the same number: under the retired origin rule the
    // reference would have gone to A's, which is the silent mis-pointing
    // T-261 P1 measured.
    for (let i = 0; i < sameNumberInA.number; i += 1) {
      await createIssue(B, `filler ${i}`);
    }

    const moved = await createIssue(B, "arrived here", "placeholder #404");
    await arrivedFrom(
      moved.id,
      { id: idA, slug: A, number: 999 },
      new Date(Date.now() + 60_000),
    );

    const res = await req(`/projects/${B}/issues/${moved.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `see #${sameNumberInA.number}` }),
    });
    expect(res.status).toBe(200);
    // The link and the event agree, because one pass produced both.
    expect((await json(res)).body).toBe(
      `see [#${sameNumberInA.number}](/projects/${idB}/issues/${sameNumberInA.number})`,
    );

    const inB = await timelineOf(B, sameNumberInA.number);
    expect(
      inB.items.filter(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toHaveLength(1);

    const inA = await timelineOf(A, sameNumberInA.number);
    expect(
      inA.items.filter((i: { event_type?: string }) =>
        ["referenced", "cross_referenced"].includes(i.event_type ?? ""),
      ),
    ).toHaveLength(0);
  });

  it("reads every segment under this project, whichever interval it falls in", async () => {
    const targetInA = await createIssue(A, "A's card");
    const targetInB = await createIssue(B, "B's card");

    const moved = await createIssue(B, "went around", "body #404");
    const commentRes = await req(
      `/projects/${B}/issues/${moved.number}/comments`,
      { method: "POST", body: JSON.stringify({ body: "written mid-trip" }) },
    );
    expect(commentRes.status).toBe(201);
    const comment = (await json(commentRes)) as { id: number };

    // The intervals have to straddle the two pieces of text, and both were
    // just written milliseconds apart — so the comment is dated explicitly
    // rather than hoped into the right window.
    const base = Date.now();
    const commentAt = new Date(base + 60_000);
    await (await dbOf(idB, B))
      .update(comments)
      .set({ createdAt: commentAt })
      .where(eq(comments.id, comment.id));

    // [ , t1) belongs to A, [t1, t2) to B, [t2, ) to B again; the body sits
    // in the first interval and the comment in the second.
    const t1 = new Date(base + 30_000);
    const t2 = new Date(base + 90_000);
    await arrivedFrom(moved.id, { id: idA, slug: A, number: 900 }, t1);
    await arrivedFrom(moved.id, { id: idB, slug: B, number: 901 }, t2);

    // The body's interval belongs to A and the comment's to B. Neither
    // matters any more: both edits are being typed in B, now.
    await req(`/projects/${B}/issues/${moved.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `body points at ${A}#${targetInA.number}` }),
    });
    await req(`/projects/${B}/issues/${moved.number}/comments/${comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `comment points at #${targetInB.number}` }),
    });

    // A's card is reached by naming A outright, which is the only spelling
    // that means it from here.
    const inA = await timelineOf(A, targetInA.number);
    const fromB = inA.items.find(
      (i: { event_type?: string }) => i.event_type === "referenced",
    );
    expect(fromB).toBeDefined();
    expect(fromB.payload.by_project_id).toBe(idB);

    const inB = await timelineOf(B, targetInB.number);
    expect(
      inB.items.some(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toBe(true);
  });

  it("reads an edit of arrived text under the project it lives in now", async () => {
    // A `#K` typed now means a card here, whatever else the stored text says.
    const here = await createIssue(B, "a card in B");
    const moved = await createIssue(
      B,
      "arrived respelled",
      `already qualified: ${A}#999`,
    );
    await arrivedFrom(
      moved.id,
      { id: idA, slug: A, number: 998 },
      new Date(Date.now() + 60_000),
    );

    const res = await req(`/projects/${B}/issues/${moved.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `now points at #${here.number}` }),
    });
    expect(res.status).toBe(200);

    const inB = await timelineOf(B, here.number);
    expect(
      inB.items.filter(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toHaveLength(1);
  });

  it("reads an edit of an arrived comment under the project it lives in now", async () => {
    const here = await createIssue(B, "comment target in B");
    const moved = await createIssue(B, "respelled comment host", "clean body");
    const commentRes = await req(
      `/projects/${B}/issues/${moved.number}/comments`,
      { method: "POST", body: JSON.stringify({ body: `see ${A}#997` }) },
    );
    expect(commentRes.status).toBe(201);
    const comment = (await json(commentRes)) as { id: number };

    const base = Date.now();
    await (await dbOf(idB, B))
      .update(comments)
      .set({ createdAt: new Date(base) })
      .where(eq(comments.id, comment.id));
    await arrivedFrom(
      moved.id,
      { id: idA, slug: A, number: 996 },
      new Date(base + 60_000),
    );

    const res = await req(
      `/projects/${B}/issues/${moved.number}/comments/${comment.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ body: `and also #${here.number}` }),
      },
    );
    expect(res.status).toBe(200);

    const inB = await timelineOf(B, here.number);
    expect(
      inB.items.filter(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toHaveLength(1);
  });

  it("records normally when an arrival names a project that is gone", async () => {
    const moved = await createIssue(B, "arrived from nowhere", "body");
    // A `moved_in` whose source no longer resolves. This used to make the
    // whole card unreadable to the extractor, because the anchor could not
    // be determined. There is no anchor to determine.
    const db = await dbOf(idB, B);
    await db.insert(issueEvents).values({
      projectId: idB,
      issueId: moved.id,
      actorId: 1,
      type: "moved_in",
      createdAt: new Date(Date.now() + 60_000),
      payload: {
        move_token: "tok-unknown",
        lineage: 1,
        from_project_id: 99999,
      },
    });

    const target = await createIssue(B, "should stay unreferenced");
    await req(`/projects/${B}/issues/${moved.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `see #${target.number}` }),
    });

    const timeline = await timelineOf(B, target.number);
    expect(
      timeline.items.filter(
        (i: { event_type?: string }) =>
          i.event_type === "referenced" || i.event_type === "cross_referenced",
      ),
    ).toHaveLength(1);
  });

  it("keeps the moved_in events out of the way of ordinary edits", async () => {
    // A card that never moved resolves exactly as before.
    const target = await createIssue(A, "plain target");
    const source = await createIssue(A, "plain source", "body");
    await req(`/projects/${A}/issues/${source.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `see #${target.number}` }),
    });
    const timeline = await timelineOf(A, target.number);
    expect(
      timeline.items.filter(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toHaveLength(1);
    const db = await dbOf(idA, A);
    expect(
      await db
        .select()
        .from(issueEvents)
        .where(
          and(eq(issueEvents.projectId, idA), eq(issueEvents.type, "moved_in")),
        ),
    ).toHaveLength(0);
  });
});
