import type { ChangeEvent } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents, issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

/**
 * Hidden comments: the elision on every merged read, the endpoint that sets
 * the mark, and the silence around it (T-281).
 */
describe("hidden comments", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "hide";

  /** Project admin, acting through the session cookie. */
  let owner: Who;
  let writer: Who;
  let reporter: Who;
  /** Whose unread state must not move when someone hides a comment. */
  let bystander: Who;

  let projectId = 0;

  const req = (path: string, who: Who, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json", ...who } : who),
        ...init?.headers,
      },
    });

  const newCard = async (title: string): Promise<number> => {
    const res = await req(`/projects/${slug}/issues`, owner, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  };

  const say = async (
    number: number,
    body: string,
    who: Who = writer,
    component?: unknown,
  ): Promise<number> => {
    const res = await req(`/projects/${slug}/issues/${number}/comments`, who, {
      method: "POST",
      body: JSON.stringify(
        component === undefined ? { body } : { body, component },
      ),
    });
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  };

  const setHidden = (
    number: number,
    ids: number[],
    hidden: boolean,
    who: Who = writer,
  ) =>
    req(`/projects/${slug}/issues/${number}/comments/hide`, who, {
      method: "POST",
      body: JSON.stringify({ hidden, comment_ids: ids }),
    });

  const hide = async (number: number, ids: number[], who: Who = writer) => {
    const res = await setHidden(number, ids, true, who);
    expect(res.status).toBe(200);
    return await json(res);
  };

  const timeline = async (number: number, query = "", who: Who = writer) => {
    const res = await req(
      `/projects/${slug}/issues/${number}/timeline?limit=100${query}`,
      who,
    );
    expect(res.status).toBe(200);
    return await json(res);
  };

  /** The comments of one timeline read, as `id → body`. */
  const bodies = async (
    number: number,
    query = "",
  ): Promise<Record<number, string>> => {
    const page = await timeline(number, query);
    return Object.fromEntries(
      page.items
        .filter((i: { type: string }) => i.type === "comment")
        .map((i: { id: number; body: string }) => [i.id, i.body]),
    );
  };

  const addMember = async (login: string, role: string): Promise<Who> => {
    const added = await addUserWithToken(t.ctx, login);
    const res = await req(`/projects/${slug}/members/${added.user.id}`, owner, {
      method: "PUT",
      body: JSON.stringify({ role }),
    });
    expect(res.status).toBe(204);
    return added.headers;
  };

  /** Every change event published while `body` runs. */
  const eventsDuring = async (body: () => Promise<void>) => {
    const seen: ChangeEvent[] = [];
    const off = t.ctx.bus.subscribe((_projectId, event) => {
      seen.push(event);
    });
    try {
      await body();
    } finally {
      off();
    }
    return seen;
  };

  const issueRow = async (number: number) => {
    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: projectId,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.number, number)));
    const row = rows[0];
    if (!row) throw new Error("issue row missing");
    return { db, row };
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    owner = { cookie };
    const created = await req("/projects", owner, {
      method: "POST",
      body: JSON.stringify({ slug, name: "Hide" }),
    });
    expect(created.status).toBe(201);
    projectId = (await json(created)).id as number;

    writer = await addMember("hide-writer", "writer");
    reporter = await addMember("hide-reporter", "reporter");
    bystander = await addMember("hide-bystander", "writer");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe("reading", () => {
    it("blanks the body, keeps the row and leaves total_count alone", async () => {
      const number = await newCard("one hidden comment");
      const first = await say(number, "the exploration");
      const second = await say(number, "the conclusion");
      const before = await timeline(number);

      await hide(number, [first]);

      const after = await timeline(number);
      expect(after.total_count).toBe(before.total_count);
      expect(after.items).toHaveLength(before.items.length);
      const shown = after.items.find(
        (i: { id: number; type: string }) =>
          i.type === "comment" && i.id === first,
      );
      expect(shown.body).toBe("");
      expect(typeof shown.hidden_at).toBe("string");
      // Everything except the body is reported as stored.
      expect(shown.author.login).toBe("hide-writer");
      expect(await bodies(number)).toEqual({
        [first]: "",
        [second]: "the conclusion",
      });
    });

    it("hands the body back for include_hidden", async () => {
      const number = await newCard("asked for on purpose");
      const id = await say(number, "the exploration");
      await hide(number, [id]);

      expect(await bodies(number, "&include_hidden=1")).toEqual({
        [id]: "the exploration",
      });
      // `true` spells the same request as `1`.
      expect(await bodies(number, "&include_hidden=true")).toEqual({
        [id]: "the exploration",
      });
    });

    it("never elides a comment asked for by id", async () => {
      const number = await newCard("named, not merged");
      const id = await say(number, "the exploration");
      await hide(number, [id]);

      const scoped = await json(
        await req(`/projects/${slug}/issues/${number}/comments/${id}`, writer),
      );
      expect(scoped.body).toBe("the exploration");
      expect(typeof scoped.hidden_at).toBe("string");

      // The bare `#comment-M` form resolves through another service.
      const bare = await json(
        await req(`/projects/${slug}/comments/${id}`, writer),
      );
      expect(bare.comment.body).toBe("the exploration");
      expect(typeof bare.comment.hidden_at).toBe("string");
    });

    it("leaves the question list whole", async () => {
      const number = await newCard("a hidden question");
      const id = await say(number, "which one?", writer, {
        type: "questions",
        questions: [
          {
            question: "Which storage?",
            options: [{ label: "a table" }, { label: "metadata" }],
          },
        ],
      });
      await hide(number, [id]);

      const list = await json(
        await req(`/projects/${slug}/issues/${number}/questions`, writer),
      );
      const [item] = list.items;
      expect(item.comment_id).toBe(id);
      expect(item.questions[0].question).toBe("Which storage?");
    });

    it("leaves the spec annotations whole", async () => {
      const number = await newCard("a hidden annotation");
      const push = await req(
        `/projects/${slug}/issues/${number}/spec/push`,
        {
          ...writer,
        },
        {
          method: "POST",
          body: JSON.stringify({
            files: [{ path: "design.md", body: "line one\nline two\n" }],
          }),
        },
      );
      expect(push.status).toBe(200);
      const review = await req(
        `/projects/${slug}/issues/${number}/spec/reviews`,
        owner,
        {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            verdict: "request_changes",
            comments: [
              {
                anchor: {
                  path: "design.md",
                  version: 1,
                  line_start: 1,
                  line_end: 1,
                },
                body: "say why",
              },
            ],
          }),
        },
      );
      expect(review.status).toBe(201);
      const [annotationId] = (await json(review)).comment_ids as number[];
      await hide(number, [annotationId as number]);

      const listed = await json(
        await req(`/projects/${slug}/issues/${number}/spec/comments`, writer),
      );
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].body).toBe("say why");
      // …while the same comment reads blank in the merged stream.
      expect((await bodies(number))[annotationId as number]).toBe("");
    });

    it("still finds the body through search, and says it is hidden", async () => {
      const number = await newCard("searchable while hidden");
      const id = await say(number, "the parakeet migration plan");
      await hide(number, [id]);

      const res = await req(
        `/projects/${slug}/search?q=${encodeURIComponent("parakeet")}`,
        writer,
      );
      expect(res.status).toBe(200);
      const hit = (await json(res)).items.find(
        (item: { comment_id: number | null }) => item.comment_id === id,
      );
      expect(hit).toBeDefined();
      expect(hit.hidden).toBe(true);
      // Asking for this text by name is explicit, so the snippet is whole.
      expect(hit.snippet.text).toContain("parakeet migration plan");
    });

    it("elides the project and cross-project activity streams alike", async () => {
      const number = await newCard("activity too");
      const id = await say(number, "the exploration");
      await hide(number, [id]);

      const commentOf = (page: {
        items: Array<{ type: string; id: number }>;
      }) =>
        page.items.find((i) => i.type === "comment" && i.id === id) as
          | { body: string; hidden_at: string | null }
          | undefined;

      for (const path of [
        `/projects/${slug}/activity?limit=100`,
        "/activity?limit=100",
      ]) {
        const quiet = commentOf(await json(await req(path, writer)));
        expect(quiet?.body).toBe("");
        expect(typeof quiet?.hidden_at).toBe("string");

        const asked = commentOf(
          await json(await req(`${path}&include_hidden=1`, writer)),
        );
        expect(asked?.body).toBe("the exploration");
      }
    });
  });

  describe("writing", () => {
    it("goes back and forth", async () => {
      const number = await newCard("there and back");
      const id = await say(number, "the exploration");

      expect(await hide(number, [id])).toEqual({
        hidden: [id],
        unchanged: [],
      });
      const back = await setHidden(number, [id], false);
      expect(back.status).toBe(200);
      expect(await json(back)).toEqual({ hidden: [id], unchanged: [] });

      const page = await timeline(number, "&include_hidden=1");
      const shown = page.items.find((i: { id: number }) => i.id === id);
      expect(shown.hidden_at).toBeNull();
      expect(shown.body).toBe("the exploration");
    });

    it("reports a replay as unchanged without rewriting the stamp", async () => {
      const number = await newCard("replayed");
      const id = await say(number, "the exploration");
      await hide(number, [id]);
      const first = await timeline(number);
      const stamp = first.items.find((i: { id: number }) => i.id === id)
        .hidden_at as string;
      expect(typeof stamp).toBe("string");

      expect(await hide(number, [id])).toEqual({
        hidden: [id],
        unchanged: [id],
      });

      const again = await timeline(number);
      expect(
        again.items.find((i: { id: number }) => i.id === id).hidden_at,
      ).toBe(stamp);
    });

    it("writes nothing when one id belongs to another card", async () => {
      const number = await newCard("the target");
      const elsewhere = await newCard("the other card");
      const mine = await say(number, "mine");
      const theirs = await say(elsewhere, "theirs");

      const res = await setHidden(number, [mine, theirs], true);
      expect(res.status).toBe(404);
      // Not even the id that did belong here.
      expect(await bodies(number)).toEqual({ [mine]: "mine" });
      expect(await bodies(elsewhere)).toEqual({ [theirs]: "theirs" });
    });

    it("publishes one timeline event for the whole call and no issue event", async () => {
      const number = await newCard("one event");
      const ids = [
        await say(number, "one"),
        await say(number, "two"),
        await say(number, "three"),
      ];

      const events = await eventsDuring(async () => {
        await hide(number, ids);
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        entity: "timeline",
        id: Math.max(...ids),
        action: "updated",
        issue_number: number,
      });
    });

    it("says nothing at all when every id is already hidden", async () => {
      const number = await newCard("nothing to do");
      const id = await say(number, "the exploration");
      await hide(number, [id]);

      const events = await eventsDuring(async () => {
        await hide(number, [id]);
      });
      expect(events).toEqual([]);
    });

    it("lets a writer hide someone else's comment and stops a reporter", async () => {
      const number = await newCard("whose comment");
      const mine = await say(number, "by the writer", writer);
      const theirs = await say(number, "by the reporter", reporter);

      // Hiding other people's exploration is the whole scenario, so this is
      // deliberately not owner-only.
      expect((await setHidden(number, [theirs], true, writer)).status).toBe(
        200,
      );
      expect((await setHidden(number, [mine], true, reporter)).status).toBe(
        403,
      );
    });

    it("refuses a card in the trash", async () => {
      const number = await newCard("in the trash");
      const id = await say(number, "the exploration");
      const trashed = await req(`/projects/${slug}/issues/${number}`, owner, {
        method: "DELETE",
      });
      expect(trashed.status).toBe(204);

      expect((await setHidden(number, [id], true, owner)).status).toBe(409);
    });
  });

  /**
   * Hiding settles what it buries (T-307). The point of every case here is
   * that a hide reaching an unsettled comment declines or resolves it
   * whoever wrote it, inside the hide's own transaction, and that `unhide`
   * gives back the body and nothing else.
   */
  describe("settling what it buries", () => {
    /** A questions comment, and the ids the settling has to reach. */
    const ask = (number: number, who: Who = writer) =>
      say(number, "which one?", who, {
        type: "questions",
        questions: [
          {
            question: "Which storage?",
            options: [{ label: "a table" }, { label: "metadata" }],
          },
          {
            question: "When?",
            options: [{ label: "now" }, { label: "later" }],
          },
        ],
      });

    /**
     * One inline annotation, written by `reviewer` on a spec `author`
     * pushed — the server refuses a review by the account that pushed, so
     * the two halves of the symmetry need different pushers.
     */
    const annotate = async (
      number: number,
      author: Who,
      reviewer: Who,
    ): Promise<number> => {
      const push = await req(
        `/projects/${slug}/issues/${number}/spec/push`,
        author,
        {
          method: "POST",
          body: JSON.stringify({
            files: [{ path: "design.md", body: "line one\nline two\n" }],
          }),
        },
      );
      expect(push.status).toBe(200);
      const review = await req(
        `/projects/${slug}/issues/${number}/spec/reviews`,
        reviewer,
        {
          method: "POST",
          body: JSON.stringify({
            version: 1,
            verdict: "request_changes",
            comments: [
              {
                anchor: {
                  path: "design.md",
                  version: 1,
                  line_start: 1,
                  line_end: 1,
                },
                body: "say why",
              },
            ],
          }),
        },
      );
      expect(review.status).toBe(201);
      const [id] = (await json(review)).comment_ids as number[];
      if (id === undefined) throw new Error("no annotation id");
      return id;
    };

    /** Every event of one card, newest last, with its payload. */
    const eventRows = async (number: number) => {
      const { db, row } = await issueRow(number);
      return await db
        .select({ type: issueEvents.type, payload: issueEvents.payload })
        .from(issueEvents)
        .where(eq(issueEvents.issueId, row.id));
    };

    const answered = async (number: number) =>
      (await eventRows(number)).filter((e) => e.type === "question_answered");

    const resolvedEvents = async (number: number) =>
      (await eventRows(number)).filter(
        (e) => e.type === "spec_comments_resolved",
      );

    it("declines every question of a comment it hides", async () => {
      const number = await newCard("hide an unanswered question");
      const id = await ask(number);
      const before = (await issueRow(number)).row.openQuestions;
      expect(before).toBe(2);

      const result = await hide(number, [id]);
      expect(result.settled).toEqual({
        declined_questions: [id],
        resolved_annotations: [],
      });

      const events = await answered(number);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        comment_id: id,
        answers: [
          { key: "q1", selected: [], other: null, declined: true },
          { key: "q2", selected: [], other: null, declined: true },
        ],
      });
      expect((await issueRow(number)).row.openQuestions).toBe(0);
    });

    it("leaves a later answer nothing to say", async () => {
      const number = await newCard("answer after the hide");
      const id = await ask(number);
      await hide(number, [id]);

      const res = await req(
        `/projects/${slug}/issues/${number}/comments/${id}/answers`,
        owner,
        {
          method: "POST",
          body: JSON.stringify({
            answers: [
              { key: "q1", selected: [0] },
              { key: "q2", selected: [0] },
            ],
          }),
        },
      );
      expect(res.status).toBe(409);
      expect(await answered(number)).toHaveLength(1);
    });

    it("settles nothing on a comment somebody already answered", async () => {
      const number = await newCard("hide an answered question");
      const id = await ask(number);
      const answer = await req(
        `/projects/${slug}/issues/${number}/comments/${id}/answers`,
        owner,
        {
          method: "POST",
          body: JSON.stringify({
            answers: [
              { key: "q1", selected: [0] },
              { key: "q2", selected: [1] },
            ],
          }),
        },
      );
      expect(answer.status).toBe(201);

      const result = await hide(number, [id]);
      expect(result.settled).toBeUndefined();
      expect(await answered(number)).toHaveLength(1);
    });

    it("resolves an annotation it hides, whoever wrote it", async () => {
      // The hider's own annotation, and somebody else's: the symmetry is
      // the requirement, so one case cannot stand in for the other.
      for (const [label, reviewer] of [
        ["their own", writer],
        ["somebody else's", owner],
      ] as const) {
        const number = await newCard(`hide ${label} annotation`);
        const author = reviewer === writer ? owner : writer;
        const id = await annotate(number, author, reviewer);
        expect((await issueRow(number)).row.specUnresolvedComments).toBe(1);

        const result = await hide(number, [id]);
        expect(result.settled).toEqual({
          declined_questions: [],
          resolved_annotations: [id],
        });

        const events = await resolvedEvents(number);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({
          comment_ids: [id],
          paths: ["design.md"],
          via: "hide",
        });
        expect((await issueRow(number)).row.specUnresolvedComments).toBe(0);

        const listed = await json(
          await req(`/projects/${slug}/issues/${number}/spec/comments`, writer),
        );
        expect(listed.items[0].resolved_at).not.toBeNull();
      }
    });

    it("settles nothing on an annotation already resolved", async () => {
      const number = await newCard("hide a resolved annotation");
      const id = await annotate(number, owner, writer);
      const resolve = await req(
        `/projects/${slug}/issues/${number}/spec/comments/resolve`,
        writer,
        { method: "POST", body: JSON.stringify({ comment_ids: [id] }) },
      );
      expect(resolve.status).toBe(200);

      const result = await hide(number, [id]);
      expect(result.settled).toBeUndefined();
      const events = await resolvedEvents(number);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        comment_ids: [id],
        paths: ["design.md"],
      });
    });

    it("settles both halves of one call, and counts them once", async () => {
      const number = await newCard("hide a question and an annotation");
      const annotation = await annotate(number, owner, writer);
      const question = await ask(number);

      const seen = await eventsDuring(async () => {
        const result = await hide(number, [question, annotation]);
        expect(result.settled).toEqual({
          declined_questions: [question],
          resolved_annotations: [annotation],
        });
      });
      // Two counters moved, one list row: a second issue event would only
      // requeue the first one's inbox work (T-275).
      expect(seen.filter((e) => e.entity === "issue")).toHaveLength(1);
      expect((await issueRow(number)).row.openQuestions).toBe(0);
      expect((await issueRow(number)).row.specUnresolvedComments).toBe(0);
    });

    it("gives back the bodies and nothing else on unhide", async () => {
      const number = await newCard("unhide settles nothing");
      const annotation = await annotate(number, owner, writer);
      const question = await ask(number);
      await hide(number, [question, annotation]);

      const res = await setHidden(number, [question, annotation], false);
      expect(res.status).toBe(200);
      const back = await json(res);
      expect(back.settled).toBeUndefined();

      const shown = await bodies(number);
      expect(shown[question]).toBe("which one?");
      expect(shown[annotation]).toBe("say why");
      // The decline and the resolve stay: an answer cannot be edited, ever.
      expect(await answered(number)).toHaveLength(1);
      expect((await issueRow(number)).row.openQuestions).toBe(0);
      expect((await issueRow(number)).row.specUnresolvedComments).toBe(0);
    });
  });

  describe("silence", () => {
    it("leaves the timeline, updated_at and other readers untouched", async () => {
      const number = await newCard("a quiet write");
      const id = await say(number, "the exploration");

      // The bystander reads the card first, so any change to their unread
      // state shows up against a known baseline.
      expect(
        (await req(`/projects/${slug}/issues/${number}`, bystander)).status,
      ).toBe(200);
      const marked = await req(
        `/projects/${slug}/issues/${number}/read`,
        bystander,
        { method: "PUT", body: JSON.stringify({}) },
      );
      expect(marked.status).toBe(204);

      const listRow = async () => {
        const res = await req(
          `/projects/${slug}/issues?numbers=${number}`,
          bystander,
        );
        const [item] = (await json(res)).items;
        return item as { unread: boolean; unread_comments: number };
      };

      const beforeRow = await listRow();
      const { db, row } = await issueRow(number);
      const beforeUpdatedAt = row.updatedAt.toISOString();
      const eventsBefore = await db
        .select({ type: issueEvents.type })
        .from(issueEvents)
        .where(eq(issueEvents.issueId, row.id));

      await hide(number, [id]);

      const { row: after } = await issueRow(number);
      expect(after.updatedAt.toISOString()).toBe(beforeUpdatedAt);
      expect(
        await db
          .select({ type: issueEvents.type })
          .from(issueEvents)
          .where(eq(issueEvents.issueId, row.id)),
      ).toEqual(eventsBefore);
      expect(await listRow()).toEqual(beforeRow);
    });
  });
});
