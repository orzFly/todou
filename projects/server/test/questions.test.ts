import type { MemberRole, Question } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const QUESTIONS = [
  {
    key: "schema",
    header: "Data model",
    question: "Where does the payload live?",
    options: [
      { label: "New entity", description: "clean but duplicated plumbing" },
      { label: "Inline in comments" },
      { label: "Events" },
    ],
  },
  {
    question: "Ship behind a flag?",
    multiple: true,
    options: [{ label: "dev" }, { label: "acme" }, { label: "prod" }],
  },
];

describe.each(PLACEMENTS)("questions T-19 (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let projectId: number;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    slug = `q-${placement.replaceAll(/[^a-z]/g, "")}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Questions" }),
    });
    expect(res.status).toBe(201);
    projectId = (await json(res)).id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(): Promise<{ id: number; number: number }> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "host questions" }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function ask(
    number: number,
    questions: unknown = QUESTIONS,
  ): Promise<Response> {
    return t.app.request(`/api/projects/${slug}/issues/${number}/comments`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        body: "context…",
        component: { type: "questions", questions },
      }),
    });
  }

  async function answer(
    number: number,
    commentId: number,
    answers: unknown,
  ): Promise<Response> {
    return t.app.request(
      `/api/projects/${slug}/issues/${number}/comments/${commentId}/answers`,
      { method: "POST", headers: headers(), body: JSON.stringify({ answers }) },
    );
  }

  async function getIssue(number: number) {
    return json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: { cookie },
      }),
    );
  }

  async function getQuestions(number: number) {
    return json(
      await t.app.request(`/api/projects/${slug}/issues/${number}/questions`, {
        headers: { cookie },
      }),
    );
  }

  async function expectOpenQuestions(number: number, expected: number) {
    expect((await getIssue(number)).open_questions).toBe(expected);
    const res = await t.app.request(
      `/api/projects/${slug}/issues?numbers=${number}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const listed = await json(res);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      number,
      open_questions: expected,
    });
    const status = await getQuestions(number);
    expect(status.open).toBe(expected);
    return status;
  }

  const GOOD_ANSWERS = [
    { key: "schema", selected: [1], other: "and keep it strict" },
    { key: "q2", selected: [0, 1], declined: false },
  ];

  it("asks: canonical keys, counter up, component on the timeline", async () => {
    const issue = await createIssue();
    const res = await ask(issue.number);
    expect(res.status).toBe(201);
    const comment = await json(res);
    expect(comment.component.type).toBe("questions");
    // Explicit key kept, missing key auto-filled by position.
    expect(comment.component.questions.map((q: Question) => q.key)).toEqual([
      "schema",
      "q2",
    ]);
    expect(comment.component.questions[1].multiple).toBe(true);

    expect((await getIssue(issue.number)).open_questions).toBe(2);

    const status = await getQuestions(issue.number);
    expect(status.open).toBe(2);
    expect(status.items).toHaveLength(1);
    expect(status.items[0].comment_id).toBe(comment.id);
    expect(status.items[0].answer).toBeNull();
  });

  it("rejects hallucinated extra fields, naming the path", async () => {
    const issue = await createIssue();
    const res = await ask(issue.number, [
      {
        question: "?",
        optoins: [{ label: "a" }, { label: "b" }],
        options: [{ label: "a" }, { label: "b" }],
      },
    ]);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.message).toContain("optoins");
  });

  it("rejects duplicate and colliding question keys", async () => {
    const issue = await createIssue();
    const dup = await ask(issue.number, [
      { key: "a", question: "?", options: [{ label: "x" }, { label: "y" }] },
      { key: "a", question: "??", options: [{ label: "x" }, { label: "y" }] },
    ]);
    expect(dup.status).toBe(422);
    expect((await json(dup)).error.message).toContain('"a"');

    // The auto-key for position 2 is q2; an explicit q2 elsewhere collides.
    const collide = await ask(issue.number, [
      { key: "q2", question: "?", options: [{ label: "x" }, { label: "y" }] },
      { question: "??", options: [{ label: "x" }, { label: "y" }] },
    ]);
    expect(collide.status).toBe(422);
  });

  it("keeps the component immutable while the body stays editable", async () => {
    const issue = await createIssue();
    const comment = await json(await ask(issue.number));

    const patched = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ body: "edited", component: null }),
      },
    );
    expect(patched.status).toBe(422);
    expect((await json(patched)).error.message).toContain("component");

    const bodyOnly = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ body: "edited" }),
      },
    );
    expect(bodyOnly.status).toBe(200);
    const after = await json(bodyOnly);
    expect(after.body).toBe("edited");
    expect(after.component.questions).toHaveLength(2);
  });

  it.each([false, true])(
    "answers atomically: label snapshots, event, counter down (legacy: %s)",
    async (legacy) => {
      const issue = await createIssue();
      const comment = await json(await ask(issue.number));
      await expectOpenQuestions(issue.number, 2);

      // Submission order differs from component order; storage normalizes.
      const res = await answer(issue.number, comment.id, [
        GOOD_ANSWERS[1],
        GOOD_ANSWERS[0],
      ]);
      expect(res.status).toBe(201);
      const event = await json(res);
      const expectedAnswers = [
        {
          key: "schema",
          selected: [{ index: 1, label: "Inline in comments" }],
          other: "and keep it strict",
          declined: false,
        },
        {
          key: "q2",
          selected: [
            { index: 0, label: "dev" },
            { index: 1, label: "acme" },
          ],
          other: null,
          declined: false,
        },
      ];
      expect(event.event_type).toBe("question_answered");
      expect(event.payload).toEqual({
        comment_id: comment.id,
        answers: expectedAnswers,
        via: "answer",
      });

      if (legacy) {
        const db = await t.ctx.router.forProject(
          routeInfoOf({ id: projectId, slug, databaseUrl: null } as Parameters<
            typeof routeInfoOf
          >[0]),
        );
        const stored = await db
          .update(issueEvents)
          .set({
            payload: { comment_id: comment.id, answers: expectedAnswers },
          })
          .where(eq(issueEvents.id, event.id))
          .returning({ payload: issueEvents.payload });
        expect(stored).toEqual([
          { payload: { comment_id: comment.id, answers: expectedAnswers } },
        ]);
        expect(stored[0]?.payload).not.toHaveProperty("via");
      }

      const status = await expectOpenQuestions(issue.number, 0);
      expect(status.items).toHaveLength(1);
      expect(status.items[0].comment_id).toBe(comment.id);
      expect(status.items[0].answer).toEqual({
        event_id: event.id,
        actor: event.actor,
        created_at: event.created_at,
        answers: expectedAnswers,
      });
      expect(
        status.items
          .filter((item: { answer: unknown }) => item.answer === null)
          .map((item: { comment_id: number }) => item.comment_id),
      ).toEqual([]);

      // Answer-once: the second submission conflicts, whatever it carries.
      const again = await answer(issue.number, comment.id, GOOD_ANSWERS);
      expect(again.status).toBe(409);
      expect((await json(again)).error.message).toContain("already answered");
      await expectOpenQuestions(issue.number, 0);

      // A remaining open comment exposes an erroneous second counter refund.
      const openComment = await json(await ask(issue.number));
      await expectOpenQuestions(issue.number, 2);
      const deleted = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
        { method: "DELETE", headers: { cookie } },
      );
      expect(deleted.status).toBe(204);
      const after = await expectOpenQuestions(issue.number, 2);
      expect(after.items).toHaveLength(1);
      expect(after.items[0].comment_id).toBe(openComment.id);
      expect(after.items[0].answer).toBeNull();
    },
  );

  it("validates answers against the component, readably", async () => {
    const issue = await createIssue();
    const comment = await json(await ask(issue.number));
    const cases: Array<{ answers: unknown; wants: string }> = [
      // All questions answer together.
      { answers: [GOOD_ANSWERS[0]], wants: "missing answers for: q2" },
      {
        answers: [GOOD_ANSWERS[0], { key: "nope", selected: [0] }],
        wants: 'unknown question key "nope"',
      },
      {
        answers: [
          { key: "schema", selected: [0], declined: true },
          GOOD_ANSWERS[1],
        ],
        wants: "declining is exclusive",
      },
      {
        answers: [{ key: "schema", selected: [0, 1] }, GOOD_ANSWERS[1]],
        wants: "single-select",
      },
      {
        answers: [{ key: "schema", selected: [3] }, GOOD_ANSWERS[1]],
        wants: "out of range",
      },
      {
        answers: [{ key: "schema" }, GOOD_ANSWERS[1]],
        wants: "select at least one option, write other text, or decline",
      },
      {
        answers: [
          { key: "schema", selected: [0], extra: true },
          GOOD_ANSWERS[1],
        ],
        wants: "extra",
      },
    ];
    for (const { answers, wants } of cases) {
      const res = await answer(issue.number, comment.id, answers);
      expect(res.status, wants).toBe(422);
      expect((await json(res)).error.message).toContain(wants);
    }
    // Still unanswered after all those rejections.
    const status = await expectOpenQuestions(issue.number, 2);
    expect(status.items).toHaveLength(1);
    expect(status.items[0].answer).toBeNull();
    const db = await t.ctx.router.forProject(
      routeInfoOf({ id: projectId, slug, databaseUrl: null } as Parameters<
        typeof routeInfoOf
      >[0]),
    );
    const events = await db
      .select()
      .from(issueEvents)
      .where(eq(issueEvents.issueId, issue.id));
    expect(
      events.filter((event) => event.type === "question_answered"),
    ).toEqual([]);
  });

  it("records a decline with a reason via answer and keeps it settled", async () => {
    const issue = await createIssue();
    const comment = await json(await ask(issue.number));
    const res = await answer(issue.number, comment.id, [
      { key: "schema", declined: true, other: "not applicable here" },
      { key: "q2", selected: [2] },
    ]);
    expect(res.status).toBe(201);
    const event = await json(res);
    const expectedAnswers = [
      {
        key: "schema",
        selected: [],
        other: "not applicable here",
        declined: true,
      },
      {
        key: "q2",
        selected: [{ index: 2, label: "prod" }],
        other: null,
        declined: false,
      },
    ];
    expect(event.payload).toEqual({
      comment_id: comment.id,
      answers: expectedAnswers,
      via: "answer",
    });
    const status = await expectOpenQuestions(issue.number, 0);
    expect(status.items).toHaveLength(1);
    expect(status.items[0].comment_id).toBe(comment.id);
    expect(status.items[0].answer).toMatchObject({
      event_id: event.id,
      answers: expectedAnswers,
    });

    const again = await answer(issue.number, comment.id, GOOD_ANSWERS);
    expect(again.status).toBe(409);
    expect((await json(again)).error.message).toContain("already answered");
    await expectOpenQuestions(issue.number, 0);
  });

  it("deleting an unanswered question comment refunds the counter", async () => {
    const issue = await createIssue();
    const comment = await json(await ask(issue.number));
    expect((await getIssue(issue.number)).open_questions).toBe(2);

    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(res.status).toBe(204);
    expect((await getIssue(issue.number)).open_questions).toBe(0);
  });

  describe("withdrawing", () => {
    type Who = { authorization: string } | null;
    const as = (who: Who) =>
      who === null ? headers() : { "content-type": "application/json", ...who };

    function withdraw(
      number: number,
      commentId: number,
      body: unknown = {},
      who: Who = null,
    ): Promise<Response> {
      return Promise.resolve(
        t.app.request(
          `/api/projects/${slug}/issues/${number}/comments/${commentId}/questions/withdraw`,
          { method: "POST", headers: as(who), body: JSON.stringify(body) },
        ),
      );
    }

    async function eventsOf(issueId: number, type: string) {
      const db = await t.ctx.router.forProject(
        routeInfoOf({ id: projectId, slug, databaseUrl: null } as Parameters<
          typeof routeInfoOf
        >[0]),
      );
      return db
        .select()
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, issueId),
            eq(issueEvents.type, type as "question_withdrawn"),
          ),
        );
    }

    async function setRole(userId: number, role: MemberRole) {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${userId}`,
        { method: "PUT", headers: headers(), body: JSON.stringify({ role }) },
      );
      expect(res.status).toBe(204);
    }

    async function member(role: MemberRole) {
      const added = await addUserWithToken(
        t.ctx,
        `${slug}-${role}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await setRole(added.user.id, role);
      return added;
    }

    it("withdraws an unsettled comment: one event, counters down, item marked", async () => {
      const issue = await createIssue();
      const comment = await json(await ask(issue.number));
      await expectOpenQuestions(issue.number, 2);

      const res = await withdraw(issue.number, comment.id, {
        reason: "  answered by the code \n",
      });
      expect(res.status).toBe(200);
      const result = await json(res);
      expect(result).toMatchObject({
        comment_id: comment.id,
        unchanged: false,
      });
      expect(typeof result.cursor).toBe("string");

      const events = await eventsOf(issue.id, "question_withdrawn");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        comment_id: comment.id,
        reason: "answered by the code",
      });

      const status = await expectOpenQuestions(issue.number, 0);
      expect(status.items).toHaveLength(1);
      expect(status.items[0].answer).toBeNull();
      expect(status.items[0].withdrawal).toMatchObject({
        event_id: events[0]?.id,
        reason: "answered by the code",
      });

      const timeline = await json(
        await t.app.request(
          `/api/projects/${slug}/issues/${issue.number}/timeline?types=question_withdrawn`,
          { headers: { cookie } },
        ),
      );
      expect(
        timeline.items.map((item: { id: number; event_type: string }) => [
          item.id,
          item.event_type,
        ]),
      ).toEqual([[events[0]?.id, "question_withdrawn"]]);
    });

    it("answers a retry unchanged, with the first cursor and reason", async () => {
      const issue = await createIssue();
      const comment = await json(await ask(issue.number));
      // Still open: a retry that took the count again would show here, where
      // a card already at 0 would hide it behind `greatest(…, 0)`.
      expect((await ask(issue.number)).status).toBe(201);
      const first = await json(
        await withdraw(issue.number, comment.id, { reason: "first" }),
      );
      await expectOpenQuestions(issue.number, 2);
      const again = await withdraw(issue.number, comment.id, {
        reason: "second",
      });
      expect(again.status).toBe(200);
      expect(await json(again)).toEqual({ ...first, unchanged: true });
      const events = await eventsOf(issue.id, "question_withdrawn");
      expect(events.map((event) => event.payload)).toEqual([
        { comment_id: comment.id, reason: "first" },
      ]);
      await expectOpenQuestions(issue.number, 2);
    });

    it("keeps the reason null when none was given", async () => {
      const issue = await createIssue();
      const comment = await json(await ask(issue.number));
      expect((await withdraw(issue.number, comment.id)).status).toBe(200);
      const events = await eventsOf(issue.id, "question_withdrawn");
      expect(events[0]?.payload).toEqual({
        comment_id: comment.id,
        reason: null,
      });
      const status = await getQuestions(issue.number);
      expect(status.items[0].withdrawal.reason).toBeNull();
    });

    it("refuses an answer after a withdrawal, and a withdrawal after an answer or a hide", async () => {
      const issue = await createIssue();
      const withdrawn = await json(await ask(issue.number));
      expect((await withdraw(issue.number, withdrawn.id)).status).toBe(200);
      const late = await answer(issue.number, withdrawn.id, GOOD_ANSWERS);
      expect(late.status).toBe(409);
      expect((await json(late)).error.message).toContain(
        `comment ${withdrawn.id} was withdrawn at`,
      );

      const answered = await json(await ask(issue.number));
      expect(
        (await answer(issue.number, answered.id, GOOD_ANSWERS)).status,
      ).toBe(201);
      const afterAnswer = await withdraw(issue.number, answered.id);
      expect(afterAnswer.status).toBe(409);
      expect((await json(afterAnswer)).error.message).toContain(
        "answered questions cannot be withdrawn",
      );

      const hidden = await json(await ask(issue.number));
      const hide = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/hide`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ hidden: true, comment_ids: [hidden.id] }),
        },
      );
      expect(hide.status).toBe(200);
      expect((await withdraw(issue.number, hidden.id)).status).toBe(409);

      await expectOpenQuestions(issue.number, 0);
      expect(await eventsOf(issue.id, "question_withdrawn")).toHaveLength(1);
    });

    it("lets the asker or a writer withdraw, and nobody else", async () => {
      const reporter = (await member("reporter")).headers;
      const writer = (await member("writer")).headers;
      const reader = (await member("reader")).headers;
      const issue = await createIssue();
      const askAs = async (who: Who) => {
        const res = await t.app.request(
          `/api/projects/${slug}/issues/${issue.number}/comments`,
          {
            method: "POST",
            headers: as(who),
            body: JSON.stringify({
              body: "context…",
              component: { type: "questions", questions: QUESTIONS },
            }),
          },
        );
        expect(res.status).toBe(201);
        return (await json(res)).id as number;
      };

      const own = await askAs(reporter);
      expect((await withdraw(issue.number, own, {}, reporter)).status).toBe(
        200,
      );

      const writers = await askAs(writer);
      const refused = await withdraw(issue.number, writers, {}, reporter);
      expect(refused.status).toBe(403);
      expect((await json(refused)).error.message).toContain(
        "only the asker or a writer",
      );

      const reporters = await askAs(reporter);
      expect((await withdraw(issue.number, reporters, {}, writer)).status).toBe(
        200,
      );

      expect((await withdraw(issue.number, writers, {}, reader)).status).toBe(
        403,
      );

      // A reader may not withdraw even the questions they asked as a reporter.
      const demoted = await member("reporter");
      const asked = await askAs(demoted.headers);
      await setRole(demoted.user.id, "reader");
      expect(
        (await withdraw(issue.number, asked, {}, demoted.headers)).status,
      ).toBe(403);
      await expectOpenQuestions(issue.number, 4);
    });

    it("rejects a comment without questions, a missing comment and a bad reason", async () => {
      const issue = await createIssue();
      const plain = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: "no questions here" }),
        },
      );
      const plainId = (await json(plain)).id;
      const none = await withdraw(issue.number, plainId);
      expect(none.status).toBe(422);
      expect((await json(none)).error.message).toContain(
        `comment ${plainId} carries no questions`,
      );

      expect((await withdraw(issue.number, 999_999)).status).toBe(404);

      const comment = await json(await ask(issue.number));
      for (const reason of [" \n\t", "x".repeat(2001)]) {
        expect(
          (await withdraw(issue.number, comment.id, { reason })).status,
        ).toBe(422);
      }
      expect(
        (await withdraw(issue.number, comment.id, { reason: "ok", extra: 1 }))
          .status,
      ).toBe(422);
      await expectOpenQuestions(issue.number, 2);
    });

    it("counts a withdrawn comment as settled when it is hidden or deleted", async () => {
      const issue = await createIssue();
      const withdrawn = await json(await ask(issue.number));
      expect((await ask(issue.number)).status).toBe(201);
      expect((await withdraw(issue.number, withdrawn.id)).status).toBe(200);
      await expectOpenQuestions(issue.number, 2);

      const hide = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/hide`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ hidden: true, comment_ids: [withdrawn.id] }),
        },
      );
      expect(hide.status).toBe(200);
      expect(await json(hide)).not.toHaveProperty("settled");
      expect(await eventsOf(issue.id, "question_answered")).toEqual([]);
      await expectOpenQuestions(issue.number, 2);

      const deleted = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/${withdrawn.id}`,
        { method: "DELETE", headers: { cookie } },
      );
      expect(deleted.status).toBe(204);
      await expectOpenQuestions(issue.number, 2);
    });
  });
});
