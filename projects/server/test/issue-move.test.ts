import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  comments,
  issueEvents,
  issueReads,
  issues,
  pendingUploads,
  revisions,
  specVersions,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { microIso } from "../src/services/timeline.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

type MoveHistory = {
  issueId: number;
  events: Array<{
    id: number;
    type: string;
    payload: unknown;
    stamp: string;
  }>;
  comments: Array<{
    id: number;
    body: string;
    component: typeof comments.$inferSelect.component;
    stamp: string;
  }>;
  revisions: Array<{
    id: number;
    subjectType: string;
    subjectId: number;
    body: string;
    stamp: string;
  }>;
};

/**
 * Moving a card between projects, end to end.
 *
 * Only the shared placement runs the single-transaction path; the other two
 * exercise the cross-database protocol, and both columns of this suite are
 * expected to be green once that lands.
 */
describe.each(PLACEMENTS)("issue move (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let admin: Who;
  /** Writer in both projects, and the author of the cards under test. */
  let author: Who;
  let authorId = 0;
  /** Writer in A only: may move nothing into B. */
  let outsider: Who;
  const A = `mv-a-${placement}`;
  const B = `mv-b-${placement}`;
  const C = `mv-c-${placement}`;
  let idA = 0;
  let idB = 0;

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json", ...who } : who),
        ...init?.headers,
      },
    });

  const dbOf = async (id: number, slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({ id, slug, databaseUrl: null } as Parameters<
        typeof routeInfoOf
      >[0]),
    );

  const createIssue = async (
    slug: string,
    title: string,
    body = "",
    who: Who = author,
  ) => {
    const res = await req(`/projects/${slug}/issues`, who, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  };

  const move = (
    from: string,
    number: number,
    to: string,
    who: Who = author,
    dryRun = false,
  ) =>
    req(`/projects/${from}/issues/${number}/move`, who, {
      method: "POST",
      body: JSON.stringify({ to_project: to, dry_run: dryRun }),
    });

  const moved = async (
    from: string,
    number: number,
    to: string,
    who = author,
  ) => {
    const res = await move(from, number, to, who);
    expect(res.status).toBe(200);
    return (await json(res)) as {
      moved_to: { slug: string; number: number };
      reinhabited: boolean;
      mapping: {
        status: { from: string; to: string };
        dropped_labels: string[];
        dropped_assignees: Array<{ login: string }>;
      };
      issue: { number: number; moves: unknown[] };
    };
  };

  const history = async (
    projectId: number,
    slug: string,
    number: number,
  ): Promise<MoveHistory> => {
    const db = await dbOf(projectId, slug);
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
    expect(issue).toBeDefined();
    const issueId = issue!.id;
    const events = await db
      .select({
        id: issueEvents.id,
        type: issueEvents.type,
        payload: issueEvents.payload,
        stamp: microIso(issueEvents.createdAt),
      })
      .from(issueEvents)
      .where(eq(issueEvents.issueId, issueId))
      .orderBy(issueEvents.id);
    const copiedComments = await db
      .select({
        id: comments.id,
        body: comments.body,
        component: comments.component,
        stamp: microIso(comments.createdAt),
      })
      .from(comments)
      .where(eq(comments.issueId, issueId))
      .orderBy(comments.id);
    const copiedRevisions = await db
      .select({
        id: revisions.id,
        subjectType: revisions.subjectType,
        subjectId: revisions.subjectId,
        body: revisions.body,
        stamp: microIso(revisions.createdAt),
      })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, projectId),
          or(
            and(
              eq(revisions.subjectType, "issue_body"),
              eq(revisions.subjectId, issueId),
            ),
            and(
              eq(revisions.subjectType, "comment"),
              inArray(
                revisions.subjectId,
                copiedComments.map((c) => c.id),
              ),
            ),
          ),
        ),
      )
      .orderBy(revisions.id);
    return {
      issueId,
      events,
      comments: copiedComments,
      revisions: copiedRevisions,
    };
  };

  const expectWatermark = (rows: MoveHistory) => {
    const arrival = rows.events
      .filter((event) => event.type === "moved_in")
      .at(-1);
    expect(arrival).toBeDefined();
    // Exclude only this arrival: a prior moved_in is itself imported history.
    const importedEvents = rows.events.filter(
      (event) => event.id !== arrival!.id,
    );
    const maximum = (items: Array<{ id: number }>) =>
      items.length === 0 ? null : Math.max(...items.map((item) => item.id));
    const boundary = {
      v: 1,
      events: maximum(importedEvents),
      comments: maximum(rows.comments),
      revisions: maximum(rows.revisions),
    };
    expect(
      (arrival!.payload as Record<string, unknown>).activity_imported_max_ids,
    ).toStrictEqual(boundary);
    if (boundary.events !== null) {
      expect(arrival!.id).toBeGreaterThan(boundary.events);
    }
    return { arrival: arrival!, boundary, importedEvents };
  };

  const addActivity = async (
    projectId: number,
    slug: string,
    issueId: number,
    body: string,
    stamp = "2025-01-02T03:04:05.123456Z",
  ) => {
    const db = await dbOf(projectId, slug);
    const createdAt = sql`${stamp}::timestamptz`;
    const [comment] = await db
      .insert(comments)
      .values({ projectId, issueId, authorId, body, createdAt })
      .returning({ id: comments.id });
    const [event] = await db
      .insert(issueEvents)
      .values({
        projectId,
        issueId,
        actorId: authorId,
        type: "title_changed",
        payload: { from: "prior title", to: body },
        createdAt,
      })
      .returning({ id: issueEvents.id });
    const edits = await db
      .insert(revisions)
      .values([
        {
          projectId,
          subjectType: "issue_body",
          subjectId: issueId,
          actorId: authorId,
          body: `${body}: prior issue body`,
          createdAt,
        },
        {
          projectId,
          subjectType: "comment",
          subjectId: comment!.id,
          actorId: authorId,
          body: `${body}: prior comment body`,
          createdAt,
        },
      ])
      .returning({ id: revisions.id });
    expect(comment).toBeDefined();
    expect(event).toBeDefined();
    expect(edits).toHaveLength(2);
    return {
      events: [event!.id],
      comments: [comment!.id],
      revisions: edits.map((revision) => revision.id),
    };
  };

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    admin = { cookie };
    for (const slug of [A, B, C]) {
      const res = await req("/projects", admin, {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      const project = (await json(res)) as { id: number };
      if (slug === A) idA = project.id;
      if (slug === B) idB = project.id;
    }

    const alice = await addUserWithToken(t.ctx, `mv-author-${placement}`);
    const bob = await addUserWithToken(t.ctx, `mv-outsider-${placement}`);
    author = alice.headers;
    authorId = alice.user.id;
    outsider = bob.headers;
    for (const [user, slugs] of [
      [alice, [A, B, C]],
      [bob, [A]],
    ] as const) {
      for (const slug of slugs) {
        const res = await req(
          `/projects/${slug}/members/${user.user.id}`,
          admin,
          { method: "PUT", body: JSON.stringify({ role: "writer" }) },
        );
        expect(res.status).toBe(204);
      }
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("moves the card, its history and its links", async () => {
    const source = await createIssue(A, "goes to B", "the body");
    const commentRes = await req(
      `/projects/${A}/issues/${source.number}/comments`,
      author,
      { method: "POST", body: JSON.stringify({ body: "a comment" }) },
    );
    expect(commentRes.status).toBe(201);
    const oldCommentId = (await json(commentRes)).id as number;

    const result = await moved(A, source.number, B);
    expect(result.moved_to.slug).toBe(B);
    expect(result.reinhabited).toBe(false);
    expect(result.issue.number).toBe(result.moved_to.number);
    expect(result.issue.moves).toHaveLength(1);

    // The card is readable at its new address, with its history.
    const timeline = await json(
      await req(
        `/projects/${B}/issues/${result.moved_to.number}/timeline?limit=100`,
        author,
      ),
    );
    expect(
      timeline.items.filter((i: { type: string }) => i.type === "comment"),
    ).toHaveLength(1);
    expect(
      timeline.items.some(
        (i: { event_type?: string }) => i.event_type === "moved_in",
      ),
    ).toBe(true);

    // …and the old addresses redirect.
    const issueRedirect = await req(
      `/projects/${A}/issues/${source.number}`,
      author,
    );
    expect(issueRedirect.status).toBe(301);
    const commentRedirect = await req(
      `/projects/${A}/comments/${oldCommentId}`,
      author,
    );
    expect(commentRedirect.status).toBe(301);
    expect((await json(commentRedirect)).moved_to.slug).toBe(B);
  });

  it("preserves personal approval rounds, versions and actor order through a real move", async () => {
    const reviewerA = await addUserWithToken(t.ctx, `mv-review-a-${placement}`);
    const reviewerB = await addUserWithToken(t.ctx, `mv-review-b-${placement}`);
    for (const reviewer of [reviewerA, reviewerB]) {
      for (const slug of [A, B]) {
        const member = await req(
          `/projects/${slug}/members/${reviewer.user.id}`,
          admin,
          { method: "PUT", body: JSON.stringify({ role: "writer" }) },
        );
        expect(member.status).toBe(204);
      }
    }
    const source = await createIssue(A, "personal approvals travel");
    const push = async (version: number) => {
      const response = await req(
        `/projects/${A}/issues/${source.number}/spec/push`,
        author,
        {
          method: "POST",
          body: JSON.stringify({
            files: [
              { path: "design.md", body: `Design version ${version}.\n` },
            ],
            message: `Version ${version}`,
          }),
        },
      );
      expect(response.status).toBe(200);
      expect((await json(response)).version).toBe(version);
    };
    const review = (
      slug: string,
      number: number,
      who: Who,
      version: number,
      verdict: "approve" | "request_changes",
    ) =>
      req(`/projects/${slug}/issues/${number}/spec/reviews`, who, {
        method: "POST",
        body: JSON.stringify({ version, verdict }),
      });
    const info = async (slug: string, number: number, who: Who) => {
      const response = await req(
        `/projects/${slug}/issues/${number}/spec`,
        who,
      );
      expect(response.status).toBe(200);
      return json(response);
    };
    const personal = async (
      slug: string,
      number: number,
      approvedA: boolean,
      approvedB: boolean,
    ) => {
      for (const [reviewer, approved] of [
        [reviewerA, approvedA],
        [reviewerB, approvedB],
      ] as const) {
        const spec = await info(slug, number, reviewer.headers);
        expect(spec.current_version).toBe(2);
        expect(spec.viewer_review).toEqual({
          user_id: reviewer.user.id,
          approved_in_current_round: approved,
        });
      }
    };
    const srcDb = await dbOf(idA, A);
    // Compare persisted rows in event-id order. Surrogate ids and project/
    // issue ids can change during a move; actor, payload and dates must not.
    const history = (db: typeof srcDb, issueId: number) =>
      db
        .select({
          actorId: issueEvents.actorId,
          payload: issueEvents.payload,
          createdAt: issueEvents.createdAt,
        })
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, issueId),
            eq(issueEvents.type, "spec_review"),
          ),
        )
        .orderBy(issueEvents.id);
    const versions = (db: typeof srcDb, issueId: number) =>
      db
        .select({
          number: specVersions.number,
          authorId: specVersions.authorId,
          message: specVersions.message,
          createdAt: specVersions.createdAt,
        })
        .from(specVersions)
        .where(eq(specVersions.issueId, issueId))
        .orderBy(specVersions.number);

    await push(1);
    expect(
      (await review(A, source.number, reviewerB.headers, 1, "approve")).status,
    ).toBe(201);
    await push(2);
    await personal(A, source.number, false, false);
    const sequence = [
      [reviewerA, "approve"],
      [reviewerB, "approve"],
      [reviewerB, "request_changes"],
      [reviewerA, "approve"],
    ] as const;
    for (const [index, [reviewer, verdict]] of sequence.entries()) {
      const response = await review(
        A,
        source.number,
        reviewer.headers,
        2,
        verdict,
      );
      expect(response.status).toBe(201);
      const eventId = (await json(response)).event_id as number;
      // These are real HTTP review events. Only their display timestamps
      // are inverted: the boundary's larger id has an earlier timestamp
      // than B's approval, and A's new approval is earlier still.
      await srcDb
        .update(issueEvents)
        .set({ createdAt: new Date(Date.UTC(2025, 0, 10 - index)) })
        .where(eq(issueEvents.id, eventId));
      if (verdict === "request_changes")
        await personal(A, source.number, false, false);
    }
    await personal(A, source.number, true, false);
    const beforeInfo = await info(A, source.number, reviewerA.headers);
    const beforeHistory = await history(srcDb, source.id);
    const beforeVersions = await versions(srcDb, source.id);
    expect(beforeHistory).toMatchObject([
      {
        actorId: reviewerB.user.id,
        payload: { version: 1, verdict: "approve" },
      },
      {
        actorId: reviewerA.user.id,
        payload: { version: 2, verdict: "approve" },
      },
      {
        actorId: reviewerB.user.id,
        payload: { version: 2, verdict: "approve" },
      },
      {
        actorId: reviewerB.user.id,
        payload: { version: 2, verdict: "request_changes" },
      },
      {
        actorId: reviewerA.user.id,
        payload: { version: 2, verdict: "approve" },
      },
    ]);
    expect(beforeVersions).toMatchObject([
      { number: 1, authorId, message: "Version 1" },
      { number: 2, authorId, message: "Version 2" },
    ]);

    const result = await moved(A, source.number, B);
    const number = result.moved_to.number;
    const dstDb = await dbOf(idB, B);
    const [destination] = await dstDb
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, idB), eq(issues.number, number)));
    if (!destination) throw new Error("missing moved spec issue");
    expect(await history(dstDb, destination.id)).toEqual(beforeHistory);
    expect(await versions(dstDb, destination.id)).toEqual(beforeVersions);
    expect(await info(B, number, reviewerA.headers)).toEqual(beforeInfo);
    await personal(B, number, true, false);
    const oldAddress = await req(
      `/projects/${A}/issues/${source.number}/spec`,
      reviewerA.headers,
    );
    expect(oldAddress.status).toBe(301);

    expect(
      (await review(B, number, reviewerA.headers, 2, "approve")).status,
    ).toBe(409);
    expect(await history(dstDb, destination.id)).toEqual(beforeHistory);
    await personal(B, number, true, false);
    // B's pre-boundary approval must not bar an approval at the destination.
    expect(
      (await review(B, number, reviewerB.headers, 2, "approve")).status,
    ).toBe(201);
    await personal(B, number, true, true);
    expect(
      (await review(B, number, reviewerB.headers, 2, "request_changes")).status,
    ).toBe(201);
    await personal(B, number, false, false);
    expect(
      (await review(B, number, reviewerA.headers, 2, "approve")).status,
    ).toBe(201);
    await personal(B, number, true, false);
    expect(
      (await review(B, number, reviewerA.headers, 2, "approve")).status,
    ).toBe(409);
    const afterHistory = await history(dstDb, destination.id);
    expect(afterHistory).toHaveLength(beforeHistory.length + 3);
    expect(afterHistory.slice(beforeHistory.length)).toMatchObject([
      {
        actorId: reviewerB.user.id,
        payload: { version: 2, verdict: "approve" },
      },
      {
        actorId: reviewerB.user.id,
        payload: { version: 2, verdict: "request_changes" },
      },
      {
        actorId: reviewerA.user.id,
        payload: { version: 2, verdict: "approve" },
      },
    ]);
    expect(await versions(dstDb, destination.id)).toEqual(beforeVersions);
  });

  /**
   * `copyComments` builds a `.values({…})` literal, so a column nobody listed
   * is a missing optional field and not a type error: without this assertion
   * the hide mark would disappear on every move with tsc, the move suite and
   * the hide suite all still green (T-281).
   */
  it("carries the hide mark to the destination", async () => {
    const source = await createIssue(A, "hidden travels", "body");
    const ids: number[] = [];
    for (const body of ["gets hidden", "stays visible"]) {
      const res = await req(
        `/projects/${A}/issues/${source.number}/comments`,
        author,
        { method: "POST", body: JSON.stringify({ body }) },
      );
      expect(res.status).toBe(201);
      ids.push((await json(res)).id as number);
    }
    const db = await dbOf(idA, A);
    await db
      .update(comments)
      .set({ hiddenAt: new Date(), hiddenBy: authorId })
      .where(and(eq(comments.projectId, idA), eq(comments.id, ids[0] ?? 0)));

    const result = await moved(A, source.number, B);
    const timeline = await json(
      await req(
        `/projects/${B}/issues/${result.moved_to.number}/timeline?limit=100&include_hidden=1`,
        author,
      ),
    );
    const carried = timeline.items.filter(
      (i: { type: string }) => i.type === "comment",
    );
    expect(carried.map((c: { body: string }) => c.body)).toEqual([
      "gets hidden",
      "stays visible",
    ]);
    // `toBeNull` alone would pass on a response that dropped the key.
    expect(typeof carried[0].hidden_at).toBe("string");
    expect(carried[1].hidden_at).toBeNull();
  });

  it("leaves the source with a bare tombstone", async () => {
    const source = await createIssue(A, "leaves nothing behind", "body");
    await req(`/projects/${A}/issues/${source.number}/comments`, author, {
      method: "POST",
      body: JSON.stringify({ body: "goes with it" }),
    });
    const form = new FormData();
    form.set("file", new File(["x"], "f.txt", { type: "text/plain" }));
    form.set("issue_number", String(source.number));
    await t.app.request(`/api/projects/${A}/attachments`, {
      method: "POST",
      headers: author,
      body: form,
    });
    const db = await dbOf(idA, A);
    await db.insert(issueReads).values({
      projectId: idA,
      issueId: source.id,
      userId: authorId,
      lastSeenAt: new Date(),
    });
    await db.insert(pendingUploads).values({
      projectId: idA,
      issueId: source.id,
      uploaderId: authorId,
      filename: "half.bin",
      contentType: "application/octet-stream",
      declaredSize: 1,
      storageKey: `pending/${placement}-${source.id}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await moved(A, source.number, B);

    for (const rows of await Promise.all([
      db.select().from(comments).where(eq(comments.issueId, source.id)),
      db.select().from(attachments).where(eq(attachments.issueId, source.id)),
      db.select().from(issueReads).where(eq(issueReads.issueId, source.id)),
      db
        .select()
        .from(pendingUploads)
        .where(eq(pendingUploads.issueId, source.id)),
    ])) {
      expect(rows).toHaveLength(0);
    }
    // Everything but the one event that says where the card went.
    const events = await db
      .select({ type: issueEvents.type })
      .from(issueEvents)
      .where(eq(issueEvents.issueId, source.id));
    expect(events.map((e) => e.type)).toEqual(["moved_out"]);
  });

  it.each(["empty", "body revision only"])(
    "keeps the tombstone out of lists and scopes watermarks to copied rows (%s history)",
    async (historyKind) => {
      const source = await createIssue(
        A,
        "vanishes from lists",
        "findable body",
      );
      const unrelated = await createIssue(B, "unrelated destination history");
      await addActivity(idB, B, unrelated.id, "unrelated");
      if (historyKind === "body revision only") {
        const db = await dbOf(idA, A);
        await db.insert(revisions).values({
          projectId: idA,
          subjectType: "issue_body",
          subjectId: source.id,
          actorId: authorId,
          body: "prior body without comments",
        });
      }
      const result = await moved(A, source.number, B);
      const copied = await history(idB, B, result.moved_to.number);
      const { boundary } = expectWatermark(copied);
      expect(copied.events.map((event) => event.type)).toEqual([
        "opened",
        "moved_in",
      ]);
      expect(copied.comments).toEqual([]);
      expect(copied.revisions).toHaveLength(historyKind === "empty" ? 0 : 1);
      if (historyKind === "body revision only") {
        expect(copied.revisions[0]).toMatchObject({
          subjectType: "issue_body",
          subjectId: copied.issueId,
          body: "prior body without comments",
        });
      }
      expect(boundary).toStrictEqual({
        v: 1,
        events: copied.events[0]!.id,
        comments: null,
        revisions: historyKind === "empty" ? null : copied.revisions[0]!.id,
      });

      const list = await json(
        await req(`/projects/${A}/issues?limit=100`, author),
      );
      expect(list.items.map((i: { number: number }) => i.number)).not.toContain(
        source.number,
      );
      const search = await json(
        await req(`/projects/${A}/search?q=findable`, author),
      );
      expect(JSON.stringify(search)).not.toContain("findable body");

      const activity = await json(
        await req(`/projects/${A}/activity?limit=100`, author),
      );
      expect(
        activity.items.some(
          (i: { event_type?: string; issue_number: number }) =>
            i.event_type === "moved_out" && i.issue_number === source.number,
        ),
      ).toBe(true);
    },
  );

  it("refuses the moves it must refuse", async () => {
    const mine = await createIssue(A, "permission checks", "body");

    // A destination the mover cannot see is a 404, not a 403: whether the
    // project exists is not something a non-member gets to learn.
    const theirs = await createIssue(
      A,
      "outsider's own card",
      "body",
      outsider,
    );
    expect((await move(A, theirs.number, B, outsider)).status).toBe(404);

    // Same project.
    const same = await move(A, mine.number, A);
    expect(same.status).toBe(422);

    // In the trash.
    const trashed = await createIssue(A, "in the trash", "body");
    expect(
      (
        await req(`/projects/${A}/issues/${trashed.number}`, author, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const fromTrash = await move(A, trashed.number, B);
    expect(fromTrash.status).toBe(409);
    expect((await json(fromTrash)).error.code).toBe("issue_deleted");

    // Already a tombstone.
    await moved(A, mine.number, B);
    const twice = await move(A, mine.number, B);
    expect(twice.status).toBe(409);
    expect((await json(twice)).error.code).toBe("issue_moved");
  });

  it("refuses a mover who is neither the author nor an admin", async () => {
    const bystander = await addUserWithToken(
      t.ctx,
      `mv-bystander-${placement}`,
    );
    for (const slug of [A, B]) {
      await req(`/projects/${slug}/members/${bystander.user.id}`, admin, {
        method: "PUT",
        body: JSON.stringify({ role: "writer" }),
      });
    }
    const source = await createIssue(A, "someone else's card", "body");
    const res = await move(A, source.number, B, bystander.headers);
    expect(res.status).toBe(403);
  });

  it("maps the status and reports what it dropped", async () => {
    const label = await json(
      await req(`/projects/${A}/labels`, admin, {
        method: "POST",
        body: JSON.stringify({ name: `only-in-a-${placement}` }),
      }),
    );
    const source = await createIssue(A, "carries a label", "body");
    await req(`/projects/${A}/issues/${source.number}`, author, {
      method: "PATCH",
      body: JSON.stringify({ label_ids: [label.id], assignee_ids: [authorId] }),
    });

    const previewRes = await move(A, source.number, B, author, true);
    expect(previewRes.status).toBe(200);
    const preview = await json(previewRes);
    expect(preview.issue).toBeNull();
    expect(preview.mapping.dropped_labels).toEqual([`only-in-a-${placement}`]);
    // Both projects seed the canonical statuses, so the name matches.
    expect(preview.mapping.status.to).toBe(preview.mapping.status.from);

    const result = await moved(A, source.number, B);
    expect(result.mapping.dropped_labels).toEqual([`only-in-a-${placement}`]);
  });

  it("writes nothing on a dry run", async () => {
    const source = await createIssue(A, "not actually moved", "body");
    const countB = async () =>
      (await json(await req(`/projects/${B}/issues?limit=100`, author))).items
        .length;
    const before = await countB();
    const res = await move(A, source.number, B, author, true);
    expect(res.status).toBe(200);
    expect(await countB()).toBe(before);
    expect(
      (await req(`/projects/${A}/issues/${source.number}`, author)).status,
    ).toBe(200);
  });

  it("takes its old number back on the return trip", async () => {
    const source = await createIssue(A, "there and back", "body");
    await addActivity(idA, A, source.id, "original history");
    const out = await moved(A, source.number, B);
    const inB = await history(idB, B, out.moved_to.number);
    const first = expectWatermark(inB);
    expect(out.reinhabited).toBe(false);
    // Activity written during the stay in B must join the next import.
    const duringStay = await addActivity(idB, B, inB.issueId, "written in B");
    const returning = await history(idB, B, out.moved_to.number);
    for (const kind of ["events", "comments", "revisions"] as const) {
      expect(first.boundary[kind]).toBeGreaterThan(0);
      for (const id of duringStay[kind]) {
        expect(id).toBeGreaterThan(first.boundary[kind]!);
      }
    }

    // Simulate stale children left on the destination tombstone. Its
    // moved_out and both polymorphic revision subjects must also disappear.
    const stale = await addActivity(idA, A, source.id, "stale tombstone");
    const tombstone = await history(idA, A, source.number);
    expect(tombstone.events.some((event) => event.type === "moved_out")).toBe(
      true,
    );
    const back = await moved(B, out.moved_to.number, A);
    expect(back.reinhabited).toBe(true);
    expect(back.moved_to.number).toBe(source.number);
    const home = await history(idA, A, source.number);
    expect(home.issueId).toBe(source.id);
    const second = expectWatermark(home);
    const arrivals = home.events.filter((event) => event.type === "moved_in");
    expect(arrivals).toHaveLength(2);
    expect(arrivals[0]!.payload).toStrictEqual(first.arrival.payload);
    expect(second.importedEvents).toContainEqual(arrivals[0]);
    expect(arrivals[0]!.id).toBeLessThanOrEqual(second.boundary.events!);
    expect(second.boundary).not.toStrictEqual(first.boundary);
    expect(home.events.some((event) => event.type === "moved_out")).toBe(false);
    expect(home.comments.map((comment) => comment.body)).toEqual([
      "original history",
      "written in B",
    ]);
    expect(home.revisions.map((revision) => revision.body).sort()).toEqual(
      returning.revisions.map((revision) => revision.body).sort(),
    );
    expect(
      second.importedEvents.map((event) => ({
        type: event.type,
        payload: event.payload,
        stamp: event.stamp,
      })),
    ).toEqual(
      returning.events.map((event) => ({
        type: event.type,
        payload: event.payload,
        stamp: event.stamp,
      })),
    );
    for (const kind of ["events", "comments", "revisions"] as const) {
      expect(home[kind]).toHaveLength(
        returning[kind].length + (kind === "events" ? 1 : 0),
      );
      expect(second.boundary[kind]).toBeGreaterThan(Math.max(...stale[kind]));
      for (const id of stale[kind]) {
        expect(home[kind].map((row) => row.id)).not.toContain(id);
      }
    }
    const dbA = await dbOf(idA, A);
    expect(
      await dbA
        .select({ id: revisions.id })
        .from(revisions)
        .where(inArray(revisions.id, stale.revisions)),
    ).toEqual([]);

    // New activity after reinhabiting is beyond the newly committed boundary.
    const fresh = await addActivity(idA, A, home.issueId, "after return");
    for (const kind of ["events", "comments", "revisions"] as const) {
      for (const id of fresh[kind]) {
        expect(id).toBeGreaterThan(second.boundary[kind]!);
      }
    }
    expect(
      (await history(idA, A, source.number)).events.find(
        (event) => event.id === second.arrival.id,
      ),
    ).toEqual(second.arrival);

    // Both legs are on the card's record, oldest first.
    const issue = await json(
      await req(`/projects/${A}/issues/${source.number}`, author),
    );
    expect(issue.moves).toHaveLength(2);
    expect(issue.moves[0].from_project).toBe(A);
    expect(issue.moves[1].from_project).toBe(B);

    // And the address that pointed at B now points home again.
    const viaB = await req(
      `/projects/${B}/issues/${out.moved_to.number}`,
      author,
    );
    expect(viaB.status).toBe(301);
    expect((await json(viaB)).moved_to).toEqual({
      slug: A,
      number: source.number,
    });
  });

  it("keeps a comment permalink one hop after A → B → A", async () => {
    const source = await createIssue(A, "permalink survives", "body");
    const first = await req(
      `/projects/${A}/issues/${source.number}/comments`,
      author,
      { method: "POST", body: JSON.stringify({ body: "the comment" }) },
    );
    const originalId = (await json(first)).id as number;

    const out = await moved(A, source.number, B);
    await moved(B, out.moved_to.number, A);

    // The very first id still resolves, and in one redirect — the aliases
    // are flattened onto the final address rather than chained.
    const res = await req(`/projects/${A}/comments/${originalId}`, author);
    expect(res.status).toBe(301);
    const body = await json(res);
    expect(body.moved_to.slug).toBe(A);
    expect(body.moved_to.number).toBe(source.number);
    const followed = await req(
      `/projects/${A}/issues/${source.number}/comments/${body.moved_to.comment_id}`,
      author,
    );
    expect(followed.status).toBe(200);
    expect((await json(followed)).body).toBe("the comment");
  });

  it("leaves the reference events on both sides untouched", async () => {
    const inA = await createIssue(A, "stays in A", "body");
    const source = await createIssue(
      A,
      "does the referencing",
      `see #${inA.number}`,
    );
    const refs = async () =>
      (
        await json(
          await req(
            `/projects/${A}/issues/${inA.number}/timeline?limit=100`,
            author,
          ),
        )
      ).items.filter((i: { event_type?: string }) =>
        ["referenced", "cross_referenced"].includes(i.event_type ?? ""),
      );

    const before = await refs();
    expect(before).toHaveLength(1);
    expect(before[0].payload).toMatchObject({
      by_project_id: idA,
      by_issue: source.number,
    });

    await moved(A, source.number, B);

    // The event says which project the reference was written in, and the
    // move did not change that. Whether the referring card still lives there
    // is what the address book answers, so nothing here needs rewriting.
    expect(await refs()).toEqual(before);
  });

  it("leaves an event that predates by_project_id exactly as it found it", async () => {
    const source = await createIssue(A, "named the old way", "body");
    const inB = await createIssue(B, "points at A by slug alone", "body");
    // Every cross_referenced event written before T-231 looks like this: the
    // slug and nothing else. `refs migrate` is what gives them an id; a move
    // must not, because it would be guessing which project held that slug.
    const dbB = await dbOf(idB, B);
    await dbB.insert(issueEvents).values({
      projectId: idB,
      issueId: inB.id,
      actorId: authorId,
      type: "cross_referenced",
      payload: { by_project: A, by_issue: source.number },
    });

    const legacyPayload = { by_project: B, by_issue: inB.number };
    const dbA = await dbOf(idA, A);
    await dbA.insert(issueEvents).values({
      projectId: idA,
      issueId: source.id,
      actorId: authorId,
      type: "cross_referenced",
      payload: legacyPayload,
    });
    const result = await moved(A, source.number, B);
    const copied = await history(idB, B, result.moved_to.number);
    const references = copied.events.filter(
      (event) => event.type === "cross_referenced",
    );
    expect(references).toHaveLength(1);
    expect(references[0]!.payload).toStrictEqual(legacyPayload);
    expect(references[0]!.payload).not.toHaveProperty("by_project_id");

    const after = await json(
      await req(
        `/projects/${B}/issues/${inB.number}/timeline?limit=100`,
        author,
      ),
    );
    const row = after.items.find(
      (i: { event_type?: string }) =>
        i.event_type === "referenced" || i.event_type === "cross_referenced",
    );
    expect(row.event_type).toBe("cross_referenced");
    expect(row.payload).toMatchObject({
      by_project: A,
      by_issue: source.number,
    });
  });

  it("copies history to the microsecond and separates imported activity by destination IDs", async () => {
    const source = await createIssue(A, "ordered history", "body");
    const stamp = "2025-01-02T03:04:05.123456Z";
    await addActivity(idA, A, source.id, "imported", stamp);
    let questionId = 0;
    for (const body of ["first", "second", "third"]) {
      const res = await req(
        `/projects/${A}/issues/${source.number}/comments`,
        author,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            ...(body === "first"
              ? {
                  component: {
                    type: "questions",
                    questions: [
                      {
                        key: "choice",
                        question: "Which option?",
                        options: [{ label: "One" }, { label: "Two" }],
                      },
                    ],
                  },
                }
              : {}),
          }),
        },
      );
      expect(res.status).toBe(201);
      if (body === "first") questionId = (await json(res)).id;
    }
    const answerRes = await req(
      `/projects/${A}/issues/${source.number}/comments/${questionId}/answers`,
      author,
      {
        method: "POST",
        body: JSON.stringify({ answers: [{ key: "choice", selected: [1] }] }),
      },
    );
    expect(answerRes.status).toBe(201);
    const answer = await json(answerRes);
    // Legacy answers carry no `via`: copying must not invent provenance.
    const legacyPayload = {
      comment_id: questionId,
      answers: answer.payload.answers,
    };
    const dbA = await dbOf(idA, A);
    await dbA
      .update(issueEvents)
      .set({ payload: legacyPayload })
      .where(eq(issueEvents.id, answer.id));
    const original = await history(idA, A, source.number);
    const before = await json(
      await req(
        `/projects/${A}/issues/${source.number}/timeline?limit=100`,
        author,
      ),
    );
    const result = await moved(A, source.number, B);
    const after = await json(
      await req(
        `/projects/${B}/issues/${result.moved_to.number}/timeline?limit=100`,
        author,
      ),
    );
    const stamps = (page: { items: Array<{ created_at: string }> }) =>
      page.items.map((i) => i.created_at);
    // The copy adds moved_in at the end and changes nothing before it.
    expect(stamps(after).slice(0, stamps(before).length)).toEqual(
      stamps(before),
    );

    const copied = await history(idB, B, result.moved_to.number);
    const { boundary, arrival, importedEvents } = expectWatermark(copied);
    expect(result.reinhabited).toBe(false);
    expect(importedEvents).toHaveLength(original.events.length);
    expect(copied.comments).toHaveLength(original.comments.length);
    expect(copied.revisions).toHaveLength(2);
    const importedComment = copied.comments.find(
      (comment) => comment.body === "imported",
    );
    expect(importedComment).toBeDefined();
    expect(copied.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectType: "issue_body",
          subjectId: copied.issueId,
          body: "imported: prior issue body",
          stamp,
        }),
        expect.objectContaining({
          subjectType: "comment",
          subjectId: importedComment!.id,
          body: "imported: prior comment body",
          stamp,
        }),
      ]),
    );
    const copiedQuestion = copied.comments.find(
      (comment) => comment.body === "first",
    );
    expect(copiedQuestion).toBeDefined();
    expect(copiedQuestion!.component).toStrictEqual(
      original.comments.find((comment) => comment.id === questionId)!.component,
    );
    const copiedAnswer = importedEvents.filter(
      (event) => event.type === "question_answered",
    );
    expect(copiedAnswer).toHaveLength(1);
    expect(copiedAnswer[0]!.payload).toStrictEqual({
      ...legacyPayload,
      comment_id: copiedQuestion!.id,
    });
    expect(copiedAnswer[0]!.payload).not.toHaveProperty("via");
    const questionsRes = await req(
      `/projects/${B}/issues/${result.moved_to.number}/questions`,
      author,
    );
    expect(questionsRes.status).toBe(200);
    const questions = await json(questionsRes);
    expect(questions.open).toBe(0);
    expect(questions.items).toHaveLength(1);
    expect(questions.items[0]).toMatchObject({
      comment_id: copiedQuestion!.id,
      answer: { answers: legacyPayload.answers },
    });

    // Backdated new activity shares the exact imported microsecond. Only
    // destination IDs distinguish it from the copy, for every source table.
    const fresh = await addActivity(idB, B, copied.issueId, "new", stamp);
    const current = await history(idB, B, result.moved_to.number);
    for (const kind of ["events", "comments", "revisions"] as const) {
      expect(boundary[kind]).toBeGreaterThan(0);
      const imported = kind === "events" ? importedEvents : copied[kind];
      expect(imported.some((row) => row.stamp === stamp)).toBe(true);
      for (const row of imported) {
        expect(row.id).toBeLessThanOrEqual(boundary[kind]!);
      }
      const newRows = current[kind].filter((row) =>
        fresh[kind].includes(row.id),
      );
      expect(newRows).toHaveLength(fresh[kind].length);
      for (const row of newRows) {
        expect(row.stamp).toBe(stamp);
        expect(row.id).toBeGreaterThan(boundary[kind]!);
      }
    }
    expect(current.events.find((event) => event.id === arrival.id)).toEqual(
      arrival,
    );
  });

  it("gives the destination's watchers one new entry, not the whole history", async () => {
    const cursorOf = async () => {
      const page = await json(
        await req(`/projects/${B}/activity?last=1&limit=1`, author),
      );
      return page.next_cursor as string;
    };
    const source = await createIssue(A, "quiet arrival", "body");
    for (const body of ["old one", "old two"]) {
      await req(`/projects/${A}/issues/${source.number}/comments`, author, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    }
    // The cursor has to be current for this to mean anything: copied rows
    // keep their original timestamps, so they only fall before a watcher's
    // position if that position is at least as recent as they are. One write
    // in B puts the cursor where a watcher that has been draining B holds it.
    await createIssue(B, "brings B's cursor up to date");
    const cursor = await cursorOf();
    const result = await moved(A, source.number, B);

    const page = await json(
      await req(
        `/projects/${B}/activity?after=${encodeURIComponent(cursor)}&limit=100`,
        author,
      ),
    );
    // The copied comments are older than the cursor, so a watcher sees the
    // arrival and not a replay of the card's whole history.
    const onCard = page.items.filter(
      (i: { issue_number: number }) =>
        i.issue_number === result.moved_to.number,
    );
    expect(onCard).toHaveLength(1);
    expect(onCard[0].event_type).toBe("moved_in");
  });

  it("hides move internals from the move response and every public timeline", async () => {
    const source = await createIssue(A, "no move internals anywhere", "body");
    const commentRes = await req(
      `/projects/${A}/issues/${source.number}/comments`,
      author,
      { method: "POST", body: JSON.stringify({ body: "mapped" }) },
    );
    expect(commentRes.status).toBe(201);
    // Start both feeds just before the move so pagination cannot hide it.
    await createIssue(B, "destination cursor baseline");
    const projectCursorRes = await req(
      `/projects/${B}/activity?last=1&limit=1`,
      author,
    );
    const crossCursorRes = await req(
      `/activity?projects=${A},${B}&last=1&limit=1`,
      author,
    );
    expect(projectCursorRes.status).toBe(200);
    expect(crossCursorRes.status).toBe(200);
    const projectCursor = (await json(projectCursorRes)).next_cursor;
    const crossCursor = (await json(crossCursorRes)).next_cursor;
    expect(typeof projectCursor).toBe("string");
    expect(typeof crossCursor).toBe("string");

    const result = await moved(A, source.number, B);
    expect(result.issue.moves).toHaveLength(1);
    expect(result.issue.moves[0]).toMatchObject({
      from_project: A,
      from_number: source.number,
    });
    const copied = await history(idB, B, result.moved_to.number);
    const { arrival } = expectWatermark(copied);
    expect(arrival.payload).toHaveProperty("id_map");

    const responses: unknown[] = [result];
    for (const path of [
      `/projects/${B}/issues/${result.moved_to.number}/timeline?limit=100`,
      `/projects/${B}/activity?after=${encodeURIComponent(projectCursor)}&limit=100`,
      `/activity?projects=${A},${B}&after=${encodeURIComponent(crossCursor)}&limit=100`,
    ]) {
      const res = await req(path, author);
      expect(res.status).toBe(200);
      const page = await json(res);
      const arrivals = page.items.filter(
        (item: { id: number; event_type?: string; project?: string }) =>
          item.id === arrival.id &&
          item.event_type === "moved_in" &&
          (item.project === undefined || item.project === B),
      );
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0].payload).toMatchObject({
        from_project: A,
        from_number: source.number,
      });
      responses.push(page);
    }
    for (const response of responses) {
      expect(JSON.stringify(response)).not.toContain("id_map");
      expect(JSON.stringify(response)).not.toContain(
        "activity_imported_max_ids",
      );
    }
  });

  it("emits both projects' change events", async () => {
    const seen: Array<{ projectId: number; action: string; entity: string }> =
      [];
    const unsub = t.ctx.bus.subscribe((projectId, event) => {
      seen.push({ projectId, action: event.action, entity: event.entity });
    });
    try {
      const source = await createIssue(A, "publishes events", "body");
      seen.length = 0;
      await moved(A, source.number, B);
      expect(seen).toContainEqual({
        projectId: idA,
        entity: "issue",
        action: "deleted",
      });
      expect(seen).toContainEqual({
        projectId: idB,
        entity: "issue",
        action: "created",
      });
    } finally {
      unsub();
    }
  });

  it("leaves a third project's reference alone as well", async () => {
    const inC = await createIssue(C, "referenced from the mover", "body");
    const source = await createIssue(
      A,
      "points at C",
      `related to ${C}#${inC.number}`,
    );
    // Give the cross-project event time to land: it is written after commit.
    await new Promise((r) => setTimeout(r, 50));
    const refs = async () =>
      (
        await json(
          await req(
            `/projects/${C}/issues/${inC.number}/timeline?limit=100`,
            author,
          ),
        )
      ).items.filter((i: { event_type?: string }) =>
        ["referenced", "cross_referenced"].includes(i.event_type ?? ""),
      );

    const before = await refs();
    expect(before).toHaveLength(1);
    expect(before[0].payload).toMatchObject({
      by_project_id: idA,
      by_issue: source.number,
    });

    await moved(A, source.number, B);
    // Reaching into a third project after a move is the part that could fail
    // silently and go unnoticed. There is nothing left to reach for.
    expect(await refs()).toEqual(before);
  });
});
