import { describe, expect, it } from "vitest";
import {
  type Captured,
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  type Route,
  runCli,
} from "./harness.ts";

/**
 * T-667: `--json --rendered` puts on each item line the very block the same
 * entry prints without `--json`, and passes the server's per-item `cursor`
 * through untouched.
 */

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};
const actor = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};

const TITLE = "读不到项目时给一条无差别提示";

const entry = {
  actor,
  created_at: "2026-08-11T12:00:00.000Z",
  agent_context: null,
};
const commentOf = (id: number, body: string, extra = {}) => ({
  type: "comment",
  id,
  author: actor,
  body,
  kind: "comment",
  component: null,
  created_at: entry.created_at,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
  ...extra,
});
const entries = [
  {
    ...entry,
    type: "event",
    id: 1,
    event_type: "opened",
    payload: {},
    cursor: "3:p1",
  },
  {
    ...commentOf(11, "第一行\n第二行\n第三行，比二十个字符更长的一行"),
    cursor: "3:p2",
  },
  {
    ...commentOf(12, "两个问题", {
      component: {
        type: "questions",
        questions: [
          {
            key: "storage",
            question: "Where should X live?",
            options: [{ label: "Reuse A" }, { label: "New entity" }],
            multiple: false,
          },
        ],
      },
    }),
    cursor: "3:p3",
  },
];

const cardRoutes: Route[] = [
  [
    "GET",
    "/api/projects",
    [
      { id: 2, slug: "todou" },
      { id: 7, slug: "acme" },
    ],
  ],
  [
    "GET",
    "/api/projects/todou/references/config",
    { format: { prefix: "T", history: [] }, autolinks: [] },
  ],
  [
    "GET",
    "/api/projects/acme/references/config",
    { format: { prefix: "D", history: [] }, autolinks: [] },
  ],
  [
    "GET",
    "/api/projects/todou/issues/146",
    { number: 146, title: TITLE, body: "正文" },
  ],
  [
    "GET",
    "/api/projects/acme/issues/5",
    { number: 5, title: TITLE, body: "正文" },
  ],
];

const routes = (): Route[] => [
  ["GET", "/api/me", me],
  [
    "GET",
    "/api/projects/todou/activity",
    (_init: RequestInit, url: URL) =>
      url.searchParams.get("after") === "a0"
        ? {
            items: entries.map((e) => ({ ...e, issue_number: 146 })),
            next_cursor: "3:p3",
            has_more: false,
          }
        : { items: [], next_cursor: null },
  ],
  [
    "GET",
    "/api/projects/todou/issues/146/timeline",
    (_init: RequestInit, url: URL) =>
      url.searchParams.get("after") === "a0"
        ? {
            items: entries,
            prev_cursor: null,
            next_cursor: "3:p3",
            has_more: false,
          }
        : { items: [], prev_cursor: null, next_cursor: null, has_more: false },
  ],
  ...cardRoutes,
];

const cardReads = (calls: Captured[]): string[] =>
  calls
    .map((c) => new URL(c.url, "http://stub.test").pathname)
    .filter((p) => p.includes("/issues") && !p.endsWith("/timeline"));

type Line = { cursor?: string; rendered?: string };

/**
 * The human batch is the item blocks joined by newlines, then the batch's
 * `cursor:` line — so the rendered fields, joined the same way, have to be
 * exactly its head.
 */
function expectRenderedMatchesHuman(human: string, items: Line[]): void {
  const rendered = items.map((i) => i.rendered);
  for (const block of rendered) expect(block).toEqual(expect.any(String));
  expect(human).toBe(`${rendered.join("\n")}\ncursor: 3:p3\n`);
}

describe.each([
  { label: "watch", command: ["watch", "-p", "todou"] },
  { label: "issue watch", command: ["issue", "watch", "146"] },
])("$label --json --rendered (T-667)", ({ command }) => {
  const run = async (...extra: string[]) => {
    const { fetchImpl, calls } = fakeFetch(routes());
    const result = await runCli(
      [...command, "--poll", "--since", "a0", ...extra],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    return { ...result, calls };
  };

  it("carries the human block of each entry, and the server's cursor", async () => {
    const human = await run();
    expect(human.exitCode).toBe(0);
    const json = await run("--json", "--rendered");
    expect(json.exitCode).toBe(0);

    const { items, cursor } = parseNdjson<Line>(json.stdout);
    expect(items.map((i) => i.cursor)).toEqual(["3:p1", "3:p2", "3:p3"]);
    expect(cursor.next_cursor).toBe("3:p3");
    expectRenderedMatchesHuman(human.stdout, items);
    expect(items[0]?.rendered).toContain(`opened "${TITLE}"`);
    expect(items[1]?.rendered).toContain("\n  第二行\n");
    expect(items[2]?.rendered).toContain("Where should X live?");
    // The rest of the line is the shape `--json` always had.
    const { rendered: _, ...rest } = items[1] as Line;
    expect(rest).toMatchObject({ type: "comment", id: 11 });
  });

  it("cuts `rendered` the way --summary cuts the human line", async () => {
    const human = await run("--summary=20");
    const json = await run("--summary=20", "--json", "--rendered");
    const { items } = parseNdjson<Line>(json.stdout);
    expectRenderedMatchesHuman(human.stdout, items);
    expect(items[1]?.rendered).not.toContain("\n");
  });

  it("is refused without --json", async () => {
    const result = await run("--rendered");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--rendered only makes sense with --json");
    expect(result.stdout).toBe("");
  });

  it("leaves plain --json lines as they were, reading no card", async () => {
    const result = await run("--json");
    expect(result.exitCode).toBe(0);
    const { items } = parseNdjson<Line>(result.stdout);
    expect(items.every((i) => !("rendered" in i))).toBe(true);
    expect(items.map((i) => i.cursor)).toEqual(["3:p1", "3:p2", "3:p3"]);
    expect(cardReads(result.calls)).toEqual([]);
  });
});

describe("multi-project watch --json --rendered (T-667)", () => {
  const cross = [
    { ...entries[0], issue_number: 146, project: "todou", cursor: "2:e1" },
    { ...entries[1], issue_number: 5, project: "acme", cursor: "2:e2" },
    { ...entries[0], id: 2, issue_number: 5, project: "acme", cursor: "2:e3" },
  ];
  const run = async (...extra: string[]) => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "e0"
            ? { items: cross, next_cursor: "2:e3", has_more: false }
            : { items: [], next_cursor: null },
      ],
      ...cardRoutes,
    ]);
    return runCli(
      ["watch", "-p", "todou,acme", "--poll", "--since", "e0", ...extra],
      { fetchImpl, env: loggedInEnv() },
    );
  };

  it("renders each entry in its own project's spelling", async () => {
    const human = await run();
    const json = await run("--json", "--rendered");
    expect(json.exitCode).toBe(0);
    const { items } = parseNdjson<Line>(json.stdout);
    expect(items.map((i) => i.cursor)).toEqual(["2:e1", "2:e2", "2:e3"]);
    expect(human.stdout).toBe(
      `${items.map((i) => i.rendered).join("\n")}\ncursor: 2:e3\n`,
    );
    expect(items[0]?.rendered).toMatch(/^T-146 /);
    expect(items[1]?.rendered).toMatch(/^D-5 /);
  });
});
