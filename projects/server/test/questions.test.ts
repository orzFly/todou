import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    options: [{ label: "dev" }, { label: "dogfood" }, { label: "prod" }],
  },
];

describe.each(PLACEMENTS)("questions #19 (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
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
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(): Promise<{ number: number }> {
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
    expect(comment.component.questions.map((q: any) => q.key)).toEqual([
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

  it("answers atomically: label snapshots, event, counter down", async () => {
    const issue = await createIssue();
    const comment = await json(await ask(issue.number));

    // Submission order differs from component order; storage normalizes.
    const res = await answer(issue.number, comment.id, [
      GOOD_ANSWERS[1],
      GOOD_ANSWERS[0],
    ]);
    expect(res.status).toBe(201);
    const event = await json(res);
    expect(event.event_type).toBe("question_answered");
    expect(event.payload.comment_id).toBe(comment.id);
    expect(event.payload.answers).toEqual([
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
          { index: 1, label: "dogfood" },
        ],
        other: null,
        declined: false,
      },
    ]);

    expect((await getIssue(issue.number)).open_questions).toBe(0);
    const status = await getQuestions(issue.number);
    expect(status.open).toBe(0);
    expect(status.items[0].answer.event_id).toBe(event.id);

    // Answer-once: the second submission conflicts, whatever it carries.
    const again = await answer(issue.number, comment.id, GOOD_ANSWERS);
    expect(again.status).toBe(409);
    expect((await json(again)).error.message).toContain("already answered");
  });

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
    expect((await getIssue(issue.number)).open_questions).toBe(2);
  });

  it("accepts a decline with a reason", async () => {
    const issue = await createIssue();
    const comment = await json(await ask(issue.number));
    const res = await answer(issue.number, comment.id, [
      { key: "schema", declined: true, other: "not applicable here" },
      { key: "q2", selected: [2] },
    ]);
    expect(res.status).toBe(201);
    const event = await json(res);
    expect(event.payload.answers[0]).toEqual({
      key: "schema",
      selected: [],
      other: "not applicable here",
      declined: true,
    });
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
