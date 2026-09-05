import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachments,
  comments,
  issueEvents,
  issueReads,
  pendingUploads,
} from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

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

  it("keeps the tombstone out of every list and puts moved_out in activity", async () => {
    const source = await createIssue(A, "vanishes from lists", "findable body");
    await moved(A, source.number, B);

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
  });

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
    const out = await moved(A, source.number, B);
    const back = await moved(B, out.moved_to.number, A);
    expect(back.reinhabited).toBe(true);
    expect(back.moved_to.number).toBe(source.number);

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

    await moved(A, source.number, B);

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

  it("copies the timeline in order, to the microsecond", async () => {
    const source = await createIssue(A, "ordered history", "body");
    for (const body of ["first", "second", "third"]) {
      await req(`/projects/${A}/issues/${source.number}/comments`, author, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    }
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

  it("hides the id map from the move's own response and reads", async () => {
    const source = await createIssue(A, "no id map anywhere", "body");
    await req(`/projects/${A}/issues/${source.number}/comments`, author, {
      method: "POST",
      body: JSON.stringify({ body: "mapped" }),
    });
    const result = await moved(A, source.number, B);
    expect(JSON.stringify(result)).not.toContain("id_map");

    const timeline = await json(
      await req(
        `/projects/${B}/issues/${result.moved_to.number}/timeline?limit=100`,
        author,
      ),
    );
    expect(JSON.stringify(timeline)).not.toContain("id_map");

    // …but the server kept it, because the protocol's recovery needs it.
    const db = await dbOf(idB, B);
    const [event] = await db
      .select({ payload: issueEvents.payload })
      .from(issueEvents)
      .where(
        and(eq(issueEvents.projectId, idB), eq(issueEvents.type, "moved_in")),
      )
      .limit(1);
    expect(event?.payload).toHaveProperty("id_map");
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
