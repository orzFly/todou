import { describe, expect, it } from "vitest";
import {
  type Captured,
  fakeFetch,
  loggedInEnv,
  type Route,
  runCli,
} from "./harness.ts";

/**
 * Hidden comments as the CLI shows and sets them (T-281): the placeholder a
 * run collapses into, the two read flags, and the three selectors of
 * `comment hide` / `comment unhide`.
 */

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
];
const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "It sprouted.",
  status: statuses[0],
  author: me,
  assignees: [me],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
};

const comment = (
  id: number,
  over: { hidden?: boolean; body?: string; component?: unknown } = {},
) => ({
  type: "comment",
  id,
  author: me,
  body: over.body ?? `body ${id}`,
  component: over.component ?? null,
  created_at: "2026-08-11T10:30:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: over.hidden === true ? "2026-08-11T11:30:00Z" : null,
  agent_context: null,
});

const openQuestions = {
  type: "questions",
  questions: [
    {
      key: "q1",
      multiple: false,
      question: "Which?",
      options: [{ label: "a" }, { label: "b" }],
    },
  ],
};

const event = (id: number) => ({
  type: "event",
  id,
  event_type: "status_changed",
  actor: me,
  payload: { from: { id: 1, name: "Todo" }, to: { id: 2, name: "Done" } },
  created_at: "2026-08-11T10:45:00Z",
  agent_context: null,
});

/**
 * A route table over one card whose timeline is `items`. The hide endpoint
 * answers the shape the real one does, so a batching bug shows up as the
 * wrong number of captured calls rather than as a crash.
 */
const routesFor = (items: unknown[]): Route[] => [
  ["GET", "/api/projects/todou/issues/3", issue],
  [
    "GET",
    "/api/projects/todou/issues/3/timeline",
    { items, prev_cursor: null, next_cursor: null, total_count: items.length },
  ],
  [
    "GET",
    "/api/projects/todou/references/config",
    { format: { prefix: "T", history: [] }, autolinks: [] },
  ],
  ["GET", "/api/me/reference-directory", { projects: [] }],
  ["PUT", "/api/projects/todou/issues/3/read", { __status: 204 }],
  [
    "POST",
    "/api/projects/todou/issues/3/comments/hide",
    (init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as {
        hidden: boolean;
        comment_ids: number[];
      };
      return { hidden: sent.comment_ids, unchanged: [] };
    },
  ],
];

/** The bodies of every hide request this run sent, in order. */
const hideCalls = (calls: Captured[]) =>
  calls
    .filter((c) => c.url.includes("/comments/hide"))
    .map(
      (c) =>
        JSON.parse(String(c.init.body)) as {
          hidden: boolean;
          comment_ids: number[];
        },
    );

const view = async (items: unknown[], argv: string[] = []) => {
  const { fetchImpl, calls } = fakeFetch(routesFor(items));
  const result = await runCli(["issue", "view", "3", ...argv], {
    fetchImpl,
    env: loggedInEnv("todou"),
  });
  expect(result.exitCode).toBe(0);
  return { ...result, calls };
};

const list = async (items: unknown[], argv: string[] = []) => {
  const { fetchImpl, calls } = fakeFetch(routesFor(items));
  const result = await runCli(["comment", "list", "3", ...argv], {
    fetchImpl,
    env: loggedInEnv("todou"),
  });
  expect(result.exitCode).toBe(0);
  return { ...result, calls };
};

const hide = async (argv: string[], items: unknown[]) => {
  const { fetchImpl, calls } = fakeFetch(routesFor(items));
  const result = await runCli(argv, { fetchImpl, env: loggedInEnv("todou") });
  return { ...result, calls };
};

describe("the hidden-run placeholder", () => {
  it("collapses a run into one line spanning its id range", async () => {
    const result = await view([
      comment(101, { hidden: true }),
      comment(102, { hidden: true }),
      comment(103, { hidden: true }),
      comment(104),
    ]);
    expect(result.stdout).toContain(
      "… 3 hidden comments (#comment-101 … #comment-103)",
    );
    expect(result.stdout).toContain("body 104");
    // Not one placeholder per comment.
    expect(result.stdout.match(/hidden comment/g)).toHaveLength(1);
  });

  it("says comment in the singular for a run of one", async () => {
    const result = await view([comment(101, { hidden: true }), comment(102)]);
    expect(result.stdout).toContain("… 1 hidden comment (#comment-101)");
  });

  it("lets an event break a run in two", async () => {
    const result = await view([
      comment(101, { hidden: true }),
      comment(102, { hidden: true }),
      event(500),
      comment(103, { hidden: true }),
    ]);
    expect(result.stdout).toContain(
      "… 2 hidden comments (#comment-101 … #comment-102)",
    );
    expect(result.stdout).toContain("… 1 hidden comment (#comment-103)");
    // The status change is the thing that must not disappear with them.
    expect(result.stdout).toContain("status_changed");
  });

  it("prints the hint once, and never under --include-hidden", async () => {
    const items = [
      comment(101, { hidden: true }),
      event(500),
      comment(102, { hidden: true }),
      comment(103),
    ];
    const collapsed = await view(items);
    expect(collapsed.stdout.match(/hidden comment/g)).toHaveLength(2);
    expect(collapsed.stdout.match(/Add --include-hidden to/g)).toHaveLength(1);

    const asked = await view(items, ["--include-hidden"]);
    expect(asked.stdout).not.toContain("Add --include-hidden to");
    expect(asked.stdout).not.toContain("hidden comments (");
    // The bodies are the point of the flag, and the header says which ones.
    expect(asked.stdout).toContain("body 101");
    expect(asked.stdout).toContain("(hidden)");
  });

  it("prints no hint on a card that hides nothing", async () => {
    const result = await view([comment(101), comment(102)]);
    expect(result.stdout).not.toContain("Add --include-hidden to");
  });

  it("asks for the bodies only when a flag wants them", async () => {
    const plain = await view([comment(101, { hidden: true })]);
    const asked = await view(
      [comment(101, { hidden: true })],
      ["--include-hidden"],
    );
    const query = (calls: Captured[]) =>
      calls.find((c) => c.url.includes("/timeline"))?.url ?? "";
    expect(query(plain.calls)).not.toContain("include_hidden");
    expect(query(asked.calls)).toContain("include_hidden=true");
  });

  it("counts a placeholder as one entry for --last", async () => {
    // Tail: [run of 2] [comment] [run of 2]. `--last 2` must answer the
    // last two *units*, which is one body and one placeholder — slicing
    // entries first would have answered two hidden comments and no body.
    const result = await view(
      [
        comment(101, { hidden: true }),
        comment(102, { hidden: true }),
        event(500),
        comment(103),
        comment(104, { hidden: true }),
        comment(105, { hidden: true }),
      ],
      ["--timeline", "--last", "2"],
    );
    expect(result.stdout).toContain("body 103");
    expect(result.stdout).toContain(
      "… 2 hidden comments (#comment-104 … #comment-105)",
    );
    expect(result.stdout).not.toContain("#comment-101");
    // Three units dropped: the first run, the event and nothing else.
    expect(result.stdout).toContain("… 2 earlier entries");
  });
});

describe("comment list", () => {
  it("collapses runs the same way issue view does", async () => {
    const result = await list([
      comment(101, { hidden: true }),
      comment(102, { hidden: true }),
      comment(103),
    ]);
    expect(result.stdout).toContain(
      "… 2 hidden comments (#comment-101 … #comment-102)",
    );
    expect(result.stdout).toContain("body 103");
  });

  it("lists only the hidden ones, in full, under --only-hidden", async () => {
    const result = await list(
      [comment(101, { hidden: true }), comment(102), comment(103)],
      ["--only-hidden"],
    );
    expect(result.stdout).toContain("body 101");
    expect(result.stdout).toContain("(hidden)");
    expect(result.stdout).not.toContain("body 102");
    // The flag exists to read them, so it must not collapse them.
    expect(result.stdout).not.toContain("hidden comments (");
    expect(
      result.calls.find((c) => c.url.includes("/timeline"))?.url,
    ).toContain("include_hidden=true");
  });
});

describe("comment hide", () => {
  it("hides the ids it was given", async () => {
    const result = await hide(
      ["comment", "hide", "3", "101", "#comment-103"],
      [comment(101), comment(102), comment(103)],
    );
    expect(result.exitCode).toBe(0);
    expect(hideCalls(result.calls)).toEqual([
      { hidden: true, comment_ids: [101, 103] },
    ]);
    expect(result.stdout).toContain("hid 2 comment(s)");
    expect(result.stdout).toContain("on T-3");
  });

  it("takes everything up to the watermark, that comment included", async () => {
    const result = await hide(
      ["comment", "hide", "3", "--to", "102", "--keep-last", "0"],
      [comment(101), comment(102), comment(103)],
    );
    expect(hideCalls(result.calls)).toEqual([
      { hidden: true, comment_ids: [101, 102] },
    ]);
  });

  it("keeps the newest three by default under --all", async () => {
    const result = await hide(
      ["comment", "hide", "3", "--all"],
      [comment(101), comment(102), comment(103), comment(104)],
    );
    expect(hideCalls(result.calls)).toEqual([
      { hidden: true, comment_ids: [101] },
    ]);
    // The line points at the command that would explain the three skips.
    expect(result.stdout).toContain("3 skipped");
    expect(result.stdout).toContain("--all --dry-run to see why");
  });

  it("sends nothing at all for --dry-run", async () => {
    const result = await hide(
      ["comment", "hide", "3", "--all", "--keep-last", "1", "--dry-run"],
      [comment(101), comment(102, { component: openQuestions }), comment(103)],
    );
    expect(result.exitCode).toBe(0);
    expect(hideCalls(result.calls)).toEqual([]);
    expect(result.stdout).toContain("would hide 1 comment(s)");
    expect(result.stdout).toContain("#comment-101");
    expect(result.stdout).toContain("would skip 2 comment(s)");
    // Every skip carries the reason it was skipped for.
    expect(result.stdout).toContain("question unanswered");
    expect(result.stdout).toContain("within the tail kept back");
    expect(result.stdout).toContain("(dry run — nothing written)");
  });

  it("names what a by-id --dry-run would settle on its way past", async () => {
    const result = await hide(
      ["comment", "hide", "3", "102", "104", "--dry-run"],
      [
        comment(101),
        comment(102, { component: openQuestions }),
        comment(104, {
          component: {
            type: "spec_comment",
            anchor: {
              path: "design.md",
              version: 1,
              line_start: 4,
              line_end: 4,
              col_start: null,
              col_end: null,
              quote: "a sentence",
            },
          },
        }),
      ],
    );
    expect(result.exitCode).toBe(0);
    expect(hideCalls(result.calls)).toEqual([]);
    expect(result.stdout).toContain("would hide 2 comment(s)");
    expect(result.stdout).toContain("would settle 2 comment(s) while hiding");
    expect(result.stdout).toContain("question unanswered → declined");
    expect(result.stdout).toContain("spec annotation unresolved → resolved");
  });

  it("refuses two selectors at once, and none at all", async () => {
    const both = await hide(
      ["comment", "hide", "3", "101", "--all"],
      [comment(101)],
    );
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("select different things");
    expect(hideCalls(both.calls)).toEqual([]);

    const neither = await hide(["comment", "hide", "3"], [comment(101)]);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain("nothing selected");
  });

  it("splits a selection past the transaction cap into two calls", async () => {
    const many = Array.from({ length: 501 }, (_, i) => comment(1000 + i));
    const result = await hide(
      ["comment", "hide", "3", "--all", "--keep-last", "0"],
      many,
    );
    const sent = hideCalls(result.calls);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.comment_ids).toHaveLength(500);
    expect(sent[1]?.comment_ids).toEqual([1500]);
  });
});

describe("comment unhide", () => {
  it("picks exactly what is hidden now under --all", async () => {
    const result = await hide(
      ["comment", "unhide", "3", "--all"],
      [
        comment(101, { hidden: true }),
        comment(102),
        comment(103, { hidden: true }),
      ],
    );
    expect(result.exitCode).toBe(0);
    // No exemption applies in this direction, so the tail comes back too.
    expect(hideCalls(result.calls)).toEqual([
      { hidden: false, comment_ids: [101, 103] },
    ]);
    expect(result.stdout).toContain("unhid 2 comment(s)");
  });

  it("puts one back by id", async () => {
    const result = await hide(
      ["comment", "unhide", "3", "101"],
      [comment(101, { hidden: true }), comment(102, { hidden: true })],
    );
    expect(hideCalls(result.calls)).toEqual([
      { hidden: false, comment_ids: [101] },
    ]);
  });
});
