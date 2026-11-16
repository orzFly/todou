import { describe, expect, it } from "vitest";
import {
  fakeFetch,
  loggedInEnv,
  runCli,
  sseStub,
  virtualClock,
} from "./harness.ts";

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

const WITHDRAWN_ITEM = {
  ...STORED_ITEM,
  withdrawal: {
    event_id: 9,
    actor: USER,
    created_at: "2026-08-12T02:00:00Z",
    reason: "answered by the code",
  },
};

const QUESTIONS_PATH = "/api/projects/todou/issues/19/questions";
const ANSWERS_PATH = "/api/projects/todou/issues/19/comments/42/answers";
const WITHDRAW_PATH =
  "/api/projects/todou/issues/19/comments/42/questions/withdraw";
const TIMELINE_PATH = "/api/projects/todou/issues/19/timeline";
const REF_CONFIG_PATH = "/api/projects/todou/references/config";

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
    // One write, whatever else the command reads (T-134 added a
    // reference-config lookup to spell the issue in the project's format).
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });

  it("still closes with the cursor the answer will land after (T-182)", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "POST",
        "/api/projects/todou/issues/19/comments",
        (init: RequestInit) => ({
          type: "comment",
          id: 42,
          body: JSON.parse(String(init.body)).body,
          cursor: "3:hlsw2ffv8g.0.16",
        }),
      ],
    ]);
    const result = await runCli(
      ["comment", "add", "19", "--body", "ctx", "--questions", "-"],
      { fetchImpl, env: loggedInEnv("todou"), stdinText: QUESTIONS_JSON },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("question wait 19 42");
    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe(
      "cursor: 3:hlsw2ffv8g.0.16 (issue watch --since <cursor>)",
    );
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
    expect(result.stdout).toContain("#comment-42");
    expect(result.stdout).toContain("awaiting answer");
    expect(result.stdout).toContain("1) New entity");
    expect(result.stdout).toContain("· User ");
  });

  it("names the answerer by display name (T-149)", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [ANSWERED_ITEM], open: 0 }],
    ]);
    const result = await runCli(["question", "list", "19"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("answered by User");
  });

  it("marks a withdrawn comment and gives its reason", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [WITHDRAWN_ITEM], open: 0 }],
    ]);
    const result = await runCli(["question", "list", "19"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("withdrawn by User");
    expect(result.stdout).toContain("  reason: answered by the code");
    expect(result.stdout).not.toContain("awaiting answer");
  });

  it("--unanswered leaves withdrawn comments out", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        QUESTIONS_PATH,
        {
          items: [WITHDRAWN_ITEM, { ...STORED_ITEM, comment_id: 43 }],
          open: 1,
        },
      ],
    ]);
    const result = await runCli(
      ["question", "list", "19", "--unanswered", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(result.stdout).items.map(
        (i: { comment_id: number }) => i.comment_id,
      ),
    ).toEqual([43]);
  });

  it("--unanswered still lists an old server's unanswered comments", async () => {
    // STORED_ITEM has no `withdrawal` key, as a server predating it sends.
    expect(STORED_ITEM).not.toHaveProperty("withdrawal");
    const { fetchImpl } = fakeFetch([
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
    ]);
    const result = await runCli(["question", "list", "19", "--unanswered"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#comment-42");
    expect(result.stdout).toContain("awaiting answer");
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
    expect(out.kind).toBe("answered");
    expect(out.answers[0].selected[0].label).toBe("Inline");
  });

  const WITHDRAWN_RESULT = {
    kind: "withdrawn",
    comment_id: 42,
    event_id: 9,
    actor: USER,
    created_at: "2026-08-12T02:00:00Z",
    reason: "answered by the code",
  };

  it("returns immediately with a withdrawal that already happened", async () => {
    const routes = () =>
      fakeFetch([
        [
          "GET",
          TIMELINE_PATH,
          { items: [], prev_cursor: null, next_cursor: "C" },
        ],
        ["GET", QUESTIONS_PATH, { items: [WITHDRAWN_ITEM], open: 0 }],
      ]).fetchImpl;
    const text = await runCli(["question", "wait", "19", "42"], {
      fetchImpl: routes(),
      env: loggedInEnv("todou"),
    });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toMatch(
      /^User withdrew #comment-42 .+ — answered by the code\n$/,
    );
    const json = await runCli(["question", "wait", "19", "42", "--json"], {
      fetchImpl: routes(),
      env: loggedInEnv("todou"),
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(WITHDRAWN_RESULT);
  });

  it("returns with a withdrawal that arrives while waiting", async () => {
    const clock = virtualClock();
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") {
            return { items: [], prev_cursor: null, next_cursor: "C0" };
          }
          return {
            items: [
              {
                type: "event",
                id: 9,
                event_type: "question_withdrawn",
                actor: USER,
                payload: { comment_id: 42, reason: "answered by the code" },
                created_at: "2026-08-12T02:00:00Z",
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
      ["question", "wait", "19", "42", "--timeout", "60", "--json"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(WITHDRAWN_RESULT);
    const drains = calls
      .map((call) => new URL(call.url, "http://stub.test"))
      .filter(
        (url) =>
          url.pathname === TIMELINE_PATH &&
          url.searchParams.get("last") !== "1",
      );
    expect(drains.length).toBeGreaterThan(0);
  });

  it("waits on an old server: no types filter, no withdrawal key", async () => {
    const clock = virtualClock();
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        (_init: RequestInit, url: URL) => {
          // A server predating withdrawals rejects the type it does not know.
          if (url.searchParams.get("types")?.includes("question_withdrawn")) {
            return {
              __status: 422,
              body: {
                error: {
                  code: "validation_failed",
                  message: "unknown type question_withdrawn",
                },
              },
            };
          }
          if (url.searchParams.get("last") === "1") {
            return { items: [], prev_cursor: null, next_cursor: "C0" };
          }
          return {
            items: [
              {
                type: "comment",
                id: 50,
                author: USER,
                body: "an unrelated comment",
                component: null,
                created_at: "2026-08-12T00:30:00Z",
                edited_at: null,
                resolved_at: null,
                hidden_at: null,
                agent_context: null,
              },
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
                      selected: [{ index: 1, label: "Inline" }],
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
      ["question", "wait", "19", "42", "--forever", "--json"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "answered",
      comment_id: 42,
      event_id: 7,
    });
    const timeline = calls
      .map((call) => new URL(call.url, "http://stub.test"))
      .filter((url) => url.pathname === TIMELINE_PATH);
    expect(timeline.every((url) => !url.searchParams.has("types"))).toBe(true);
  });

  it("heads its text output with the pastable comment ref", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        { items: [], prev_cursor: null, next_cursor: "C" },
      ],
      ["GET", QUESTIONS_PATH, { items: [ANSWERED_ITEM], open: 0 }],
    ]);
    const result = await runCli(["question", "wait", "19", "42"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("answered #comment-42");
  });

  it("takes the id in the spelling the renderers print", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        TIMELINE_PATH,
        { items: [], prev_cursor: null, next_cursor: "C" },
      ],
      ["GET", QUESTIONS_PATH, { items: [ANSWERED_ITEM], open: 0 }],
    ]);
    const result = await runCli(["question", "wait", "19", "#comment-42"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("answered #comment-42");
  });

  it.each([
    { name: "legacy answer", via: undefined, declined: false },
    { name: "legacy decline", via: undefined, declined: true },
    { name: "active answer", via: "answer", declined: false },
    { name: "explicit decline", via: "answer", declined: true },
    { name: "hide settlement", via: "hide", declined: true },
  ])("decodes the arriving $name as answered", async ({ via, declined }) => {
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
                  ...(via === undefined ? {} : { via }),
                  answers: [
                    {
                      key: "schema",
                      selected: declined
                        ? []
                        : [{ index: 0, label: "New entity" }],
                      other: null,
                      declined,
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
    expect(out.kind).toBe("answered");
    expect(out.event_id).toBe(7);
    expect(out.answers).toEqual([
      {
        key: "schema",
        selected: declined ? [] : [{ index: 0, label: "New entity" }],
        other: null,
        declined,
      },
    ]);
    expect(result.stdout).not.toContain("no answer within");
    expect(polls).toBe(2);
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
    expect(result.stdout).toContain("answered #comment-42");
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

describe("question withdraw", () => {
  const cursor = "3:hlsw2ffv8g.1.3pz";
  const response = { comment_id: 42, unchanged: false, cursor };

  it("posts the trimmed reason, then prints the result and the cursor", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["POST", WITHDRAW_PATH, response],
      [
        "GET",
        REF_CONFIG_PATH,
        { format: { prefix: "TOD", history: [] }, autolinks: [] },
      ],
    ]);
    const result = await runCli(
      [
        "question",
        "withdraw",
        "19",
        "42",
        "--reason",
        "  answered by the code \n",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const posts = calls.filter((c) => c.init.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.init.body))).toEqual({
      reason: "answered by the code",
    });
    expect(result.stdout).toBe(
      `withdrew #comment-42 on TOD-19\ncursor: ${cursor} (issue watch --since <cursor>)\n`,
    );
    expect(result.stderr).toBe("");
  });

  it("reports a retry as unchanged without claiming its new reason was saved", async () => {
    const { fetchImpl } = fakeFetch([
      ["POST", WITHDRAW_PATH, { ...response, unchanged: true }],
    ]);
    const result = await runCli(
      ["question", "withdraw", "19", "42", "--reason", "a different reason"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `#comment-42 already withdrawn (unchanged)\ncursor: ${cursor} (issue watch --since <cursor>)\n`,
    );
  });

  it.each([false, true])(
    "prints the API result as it came under --json (unchanged=%s)",
    async (unchanged) => {
      const sent = { ...response, unchanged };
      const { fetchImpl, calls } = fakeFetch([["POST", WITHDRAW_PATH, sent]]);
      const result = await runCli(
        ["question", "withdraw", "19", "42", "--json"],
        { fetchImpl, env: loggedInEnv("todou") },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(sent);
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({});
    },
  );

  it.each(["", " \n\t", "x".repeat(2001)])(
    "rejects an invalid reason before any request",
    async (reason) => {
      const { fetchImpl, calls } = fakeFetch([]);
      const result = await runCli(
        ["question", "withdraw", "19", "42", "--reason", reason],
        { fetchImpl, env: loggedInEnv("todou") },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--reason");
      expect(calls).toHaveLength(0);
    },
  );

  it("fails on a conflict, writing nothing to stdout", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        WITHDRAW_PATH,
        {
          __status: 409,
          body: {
            error: {
              code: "conflict",
              message:
                "comment 42 was already answered at 2026-08-12T01:00:00.000Z — answered questions cannot be withdrawn",
            },
          },
        },
      ],
    ]);
    const result = await runCli(["question", "withdraw", "19", "42"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "error: conflict — comment 42 was already answered",
    );
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });
});

describe("question wait: listed as a live watcher (T-540)", () => {
  const run = async (extra: string[]) => {
    const sse = sseStub();
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        TIMELINE_PATH,
        { items: [], prev_cursor: null, next_cursor: null },
      ],
      ["GET", QUESTIONS_PATH, { items: [STORED_ITEM], open: 1 }],
    ]);
    const result = await runCli(
      ["question", "wait", "19", "42", "--timeout", "4", ...extra],
      { fetchImpl, env: loggedInEnv("todou"), clock: virtualClock() },
    );
    expect(result.exitCode).toBe(3);
    const feed = calls
      .map((call) => new URL(call.url, "http://stub.test"))
      .find((url) => url.pathname === "/api/events");
    expect(feed).toBeDefined();
    return {
      watch: feed?.searchParams.get("watch") ?? null,
      kind: feed?.searchParams.get("watch_kind") ?? null,
    };
  };

  it("declares the card as a question wait", async () => {
    expect(await run([])).toEqual({
      watch: "issue:todou/19",
      kind: "question_wait",
    });
  });

  it("--invisible declares nothing", async () => {
    expect(await run(["--invisible"])).toEqual({ watch: null, kind: null });
  });
});
