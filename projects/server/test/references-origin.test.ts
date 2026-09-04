import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments, issueEvents } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * References resolve under the project that owned the card when the text was
 * written (T-231 §4.2) — the half of the origin rule that lives in the writer
 * rather than the reader.
 *
 * Since T-247 a move respells what it can, so this rule is what covers the
 * text it could not: every fixture here therefore carries a bare origin-local
 * ref in its STORED text, which is the condition `editAnchorFor` reads.
 *
 * No executor is involved: a hand-written `moved_in` event is all an
 * ownership interval is, which is exactly why the design reads them from the
 * timeline instead of adding a column.
 */
describe.each(PLACEMENTS)("reference origin (%s placement)", (placement) => {
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

  it("reads a bare ref in pre-move text as the source project's", async () => {
    const targetInA = await createIssue(A, "referred to from the past");
    // A card in B with the same number would swallow the reference if the
    // text were read under B's numbering — and that card really exists, so
    // no redirect would ever fire to correct it.
    for (let i = 0; i < targetInA.number; i += 1) {
      await createIssue(B, `filler ${i}`);
    }

    // `#404` names nothing in either project, so it records no event of its
    // own — it is here to say the stored text still spells A's numbering.
    const moved = await createIssue(B, "arrived here", "placeholder #404");
    await arrivedFrom(
      moved.id,
      { id: idA, slug: A, number: 999 },
      new Date(Date.now() + 60_000),
    );

    const res = await req(`/projects/${B}/issues/${moved.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `see #${targetInA.number}` }),
    });
    expect(res.status).toBe(200);

    // The reference landed in A, as a cross-project one.
    const inA = await timelineOf(A, targetInA.number);
    const cross = inA.items.find(
      (i: { event_type?: string }) => i.event_type === "cross_referenced",
    );
    expect(cross).toBeDefined();
    expect(cross.payload.by_project).toBe(B);
    expect(cross.payload.by_project_id).toBe(idB);

    // …and not on B's card of the same number.
    const sameNumberInB = await timelineOf(B, targetInA.number);
    expect(
      sameNumberInB.items.filter(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toHaveLength(0);
  });

  it("splits a round trip into intervals, each read under its own owner", async () => {
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

    await req(`/projects/${B}/issues/${moved.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `body points at #${targetInA.number}` }),
    });
    await req(`/projects/${B}/issues/${moved.number}/comments/${comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: `comment points at #${targetInB.number}` }),
    });

    const inA = await timelineOf(A, targetInA.number);
    expect(
      inA.items.some(
        (i: { event_type?: string }) => i.event_type === "cross_referenced",
      ),
    ).toBe(true);

    // The comment was written while the card was in B, so its `#N` is local.
    const inB = await timelineOf(B, targetInB.number);
    expect(
      inB.items.some(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toBe(true);
  });

  it("reads an edit of respelled text under the project it lives in now", async () => {
    // What a move leaves behind since T-247: the card's own references name
    // their project outright, so nothing in the stored text still belongs to
    // A's numbering — and a `#K` typed now means a card here.
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

  it("reads an edit of a respelled comment under the project it lives in now", async () => {
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

  it("records nothing when the source project is unknown", async () => {
    const moved = await createIssue(B, "arrived from nowhere", "body");
    // A `moved_in` whose source no longer resolves: the interval's owner is
    // unknowable, and guessing "the current project" would attach the
    // reference to a card the text never meant.
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
    ).toHaveLength(0);
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
