import type { Question } from "@todou/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

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
});
