import { describe, expect, it } from "vitest";
import { fakeFetch, loggedInEnv, runCli, virtualClock } from "./harness.ts";

const USER = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
};

const QUESTIONS_JSON = JSON.stringify([
  {
    key: "schema",
    header: "Data model",
    question: "Where does the payload live?",
    options: [{ label: "New entity" }, { label: "Inline" }],
  },
]);

const STORED_ITEM = {
  comment_id: 42,
  author: USER,
  created_at: "2026-08-12T00:00:00Z",
  questions: [
    {
      key: "schema",
      header: "Data model",
      question: "Where does the payload live?",
      multiple: false,
      options: [{ label: "New entity" }, { label: "Inline" }],
    },
  ],
  answer: null,
};

const ANSWERED_ITEM = {
  ...STORED_ITEM,
  answer: {
    event_id: 7,
    actor: USER,
    created_at: "2026-08-12T01:00:00Z",
    answers: [
      {
        key: "schema",
        selected: [{ index: 1, label: "Inline" }],
        other: "ship it",
        declined: false,
      },
    ],
  },
};

const QUESTIONS_PATH = "/api/projects/todou/issues/19/questions";
const ANSWERS_PATH = "/api/projects/todou/issues/19/comments/42/answers";
const TIMELINE_PATH = "/api/projects/todou/issues/19/timeline";

describe("comment add --questions", () => {
  it("sends the component and points at question wait", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/19/comments",
        (init: RequestInit) => {
          const sent = JSON.parse(String(init.body));
          expect(sent.component.type).toBe("questions");
          expect(sent.component.questions).toHaveLength(1);
          return { type: "comment", id: 42, body: sent.body };
        },
      ],
    ]);
    const result = await runCli(
      ["comment", "add", "19", "--body", "ctx", "--questions", "-"],
      { fetchImpl, env: loggedInEnv("todou"), stdinText: QUESTIONS_JSON },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("question wait 19 42");
    expect(calls).toHaveLength(1);
  });

  it("rejects hallucinated fields locally, naming the path", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await runCli(
      ["comment", "add", "19", "--body", "ctx", "--questions", "-"],
      {
        fetchImpl,
        env: loggedInEnv("todou"),
        stdinText: JSON.stringify([
          {
            question: "?",
            optoins: [{ label: "a" }, { label: "b" }],
            options: [{ label: "a" }, { label: "b" }],
          },
        ]),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("optoins");
    // Validation failed before any network round trip.
    expect(calls).toHaveLength(0);
  });

  it("rejects a questions file that is not JSON", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["comment", "add", "19", "--body", "x", "--questions", "-"],
      { fetchImpl, env: loggedInEnv("todou"), stdinText: "not json" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not valid JSON");
  });
});

describe("question list", () => {
  it("renders questions with numbering and answer state", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
    ]);
    const result = await runCli(["question", "list", "19"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("comment 42");
    expect(result.stdout).toContain("awaiting answer");
    expect(result.stdout).toContain("1) New entity");
  });

  it("--unanswered hides answered comments", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [ANSWERED_ITEM], open: 0 }],
    ]);
    const result = await runCli(["question", "list", "19", "--unanswered"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no unanswered questions");
  });
});

describe("question wait", () => {
  it("returns immediately when the comment is already answered", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        { items: [], prev_cursor: null, next_cursor: "C" },
      ],
      ["GET", QUESTIONS_PATH, { items: [ANSWERED_ITEM], open: 0 }],
    ]);
    const result = await runCli(["question", "wait", "19", "42", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.answers[0].selected[0].label).toBe("Inline");
  });

  it("decodes the question_answered event when it arrives", async () => {
    const clock = virtualClock();
    let polls = 0;
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        (_init: RequestInit, url: URL) => {
          // First call bootstraps the baseline cursor (last=1).
          if (url.searchParams.get("last") === "1") {
            return { items: [], prev_cursor: null, next_cursor: "C0" };
          }
          polls += 1;
          if (polls < 2) {
            return { items: [], prev_cursor: null, next_cursor: null };
          }
          return {
            items: [
              {
                type: "event",
                id: 7,
                event_type: "question_answered",
                actor: USER,
                payload: {
                  comment_id: 42,
                  answers: [
                    {
                      key: "schema",
                      selected: [{ index: 0, label: "New entity" }],
                      other: null,
                      declined: false,
                    },
                  ],
                },
                created_at: "2026-08-12T01:00:00Z",
                agent_context: null,
              },
            ],
            prev_cursor: null,
            next_cursor: null,
          };
        },
      ],
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
    ]);
    const result = await runCli(
      [
        "question",
        "wait",
        "19",
        "42",
        "--timeout",
        "300",
        "--interval",
        "2",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.event_id).toBe(7);
    expect(out.answers[0].key).toBe("schema");
    expect(clock.elapsed()).toBe(2_000);
  });

  it("exits 3 on timeout without an answer", async () => {
    const clock = virtualClock();
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        { items: [], prev_cursor: null, next_cursor: null },
      ],
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
    ]);
    const result = await runCli(
      ["question", "wait", "19", "42", "--timeout", "60", "--interval", "2"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("no answer within");
    expect(clock.elapsed()).toBe(60_000);
  });

  it("fails fast when the comment carries no questions", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        { items: [], prev_cursor: null, next_cursor: null },
      ],
      ["GET", QUESTIONS_PATH, { items: [], open: 0 }],
    ]);
    const result = await runCli(["question", "wait", "19", "42"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("carries no questions");
  });
});

describe("question answer", () => {
  it("resolves labels and 1-based positions through the sugar path", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
      [
        "POST",
        ANSWERS_PATH,
        (init: RequestInit) => {
          const sent = JSON.parse(String(init.body));
          expect(sent.answers).toEqual([
            { key: "schema", selected: [1], other: "ship it", declined: false },
          ]);
          return { type: "event", id: 7, event_type: "question_answered" };
        },
      ],
    ]);
    const result = await runCli(
      [
        "question",
        "answer",
        "19",
        "42",
        "--select",
        "Inline",
        "--other",
        "ship it",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("answered comment 42");
  });

  it("names the options when a label does not match", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
    ]);
    const result = await runCli(
      ["question", "answer", "19", "42", "--select", "Inlnie"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no option labeled "Inlnie"');
    expect(result.stderr).toContain("1) New entity");
  });

  it("validates --answers strictly before sending", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const result = await runCli(
      [
        "question",
        "answer",
        "19",
        "42",
        "--answers",
        '[{"key":"schema","selected":[0],"extra":1}]',
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("extra");
    expect(calls).toHaveLength(0);
  });
});
