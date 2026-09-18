import { describe, expect, it } from "vitest";
import { fakePeerPush } from "./fake-peer-push.ts";
import {
  type Captured,
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  type Route,
  runCli,
  sseStub,
  virtualClock,
} from "./harness.ts";

/**
 * T-286 end to end: an `opened` entry carries the card's title and body, a
 * reference carries the title of the card it came from, and both go out over
 * every consumer of `renderHuman` — the one-shot batch and the push body
 * alike, which is what keeps the two from drifting apart.
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
const BODY = "第一行\n第二行";
const REFERRER = "评论 collapse：把中间的探索讨论折叠掉";

const opened = (issue: number, project?: string) => ({
  type: "event",
  id: 1,
  event_type: "opened",
  actor,
  payload: {},
  created_at: "2026-08-11T12:00:00.000Z",
  issue_number: issue,
  ...(project === undefined ? {} : { project }),
});
const referenced = (
  issue: number,
  payload: Record<string, unknown>,
  project?: string,
) => ({
  type: "event",
  id: 2,
  event_type: "referenced",
  actor,
  payload,
  created_at: "2026-08-11T12:00:00.000Z",
  issue_number: issue,
  ...(project === undefined ? {} : { project }),
});

/** Reads this account can make about projects and cards, all optional. */
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
    { number: 146, title: TITLE, body: BODY },
  ],
  [
    "GET",
    "/api/projects/todou/issues",
    { items: [{ number: 281, title: REFERRER }] },
  ],
];

const issueReads = (calls: Captured[]): string[] =>
  calls
    .map((c) => new URL(c.url, "http://stub.test"))
    .filter((u) => u.pathname.includes("/issues"))
    .map((u) => `${u.pathname}${u.search}`);

describe("watch: the cards an entry is about (T-286)", () => {
  const batch = [
    opened(146),
    referenced(30, { by_project_id: 2, by_issue: 281, by_comment: 4242 }),
  ];

  it("gives an opened card its title and body, and a reference its target's title", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? { items: batch, next_cursor: "a1", has_more: false }
            : { items: [], next_cursor: null },
      ],
      ...cardRoutes,
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0"],
      { fetchImpl, env: loggedInEnv() },
    );

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^T-146 User opened "${TITLE}" .+: 第一行$`),
    );
    expect(lines[1]).toBe("  第二行");
    expect(lines[2]).toContain(
      `referenced (by T-281 "${REFERRER}" #comment-4242)`,
    );
    // The reference target came off the batch endpoint, the opened card off
    // its own read — a list row has no body to give.
    expect(issueReads(calls)).toEqual([
      "/api/projects/todou/issues/146",
      "/api/projects/todou/issues?numbers=281&limit=1",
    ]);
  });

  it("reads no card at all under --json", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? { items: batch, next_cursor: "a1", has_more: false }
            : { items: [], next_cursor: null },
      ],
      ...cardRoutes,
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );

    expect(result.exitCode).toBe(0);
    // The item lines are the shape they always had: a title is prose, and
    // adding fields to what a script parses is a separate decision (T-283).
    const { items } = parseNdjson<{ event_type: string }>(result.stdout);
    expect(items.map((i) => i.event_type)).toEqual(["opened", "referenced"]);
    expect(issueReads(calls)).toEqual([]);
  });

  it("resolves each project's cards against that project, across a merged stream", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "e0"
            ? {
                items: [
                  opened(146, "todou"),
                  // From acme's side this is a foreign reference, so it
                  // is spelled — and resolved — against `todou`.
                  referenced(5, { by_project_id: 2, by_issue: 281 }, "acme"),
                ],
                next_cursor: "e1",
                has_more: false,
              }
            : { items: [], next_cursor: null },
      ],
      ...cardRoutes,
    ]);
    const result = await runCli(
      ["watch", "-p", "todou,acme", "--poll", "--since", "e0"],
      { fetchImpl, env: loggedInEnv() },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`T-146 User opened "${TITLE}"`);
    expect(result.stdout).toContain(
      `D-5 User referenced (by todou#281 "${REFERRER}")`,
    );
    expect(issueReads(calls)).toEqual([
      "/api/projects/todou/issues/146",
      "/api/projects/todou/issues?numbers=281&limit=1",
    ]);
  });
});

describe("single-project block watches", () => {
  const blockEntries = [
    {
      ...opened(146),
      id: 71,
      event_type: "block_added",
      payload: {
        edge_id: 301,
        role: "blocked",
        other_project_id: 7,
        other_project: "acme",
        other_number: 9,
      },
    },
    {
      ...opened(146),
      id: 72,
      event_type: "block_removed",
      payload: {
        edge_id: 302,
        role: "blocker",
        other_project_id: 7,
        other_number: 10,
      },
    },
    {
      ...opened(146),
      id: 73,
      event_type: "block_cleared",
      payload: {
        edge_id: 303,
        blocker_project_id: null,
        blocker_project: null,
        blocker_number: null,
      },
    },
    {
      ...opened(146),
      id: 74,
      event_type: "block_reblocked",
      payload: {
        edge_id: 304,
        blocker_project_id: 7,
        blocker_project: "acme",
        blocker_number: 11,
      },
    },
  ];

  it.each([
    { label: "project watch", command: ["watch", "-p", "todou"] },
    { label: "issue watch", command: ["issue", "watch", "146"] },
  ])(
    "$label renders relations without reading the other endpoint or changing NDJSON",
    async ({ command }) => {
      const run = async (json: boolean) => {
        const { fetchImpl, calls } = fakeFetch([
          ["GET", "/api/me", me],
          [
            "GET",
            "/api/projects/todou/activity",
            (_init: RequestInit, url: URL) =>
              url.searchParams.get("after") === "a0"
                ? { items: blockEntries, next_cursor: "a1", has_more: false }
                : { items: [], next_cursor: null },
          ],
          [
            "GET",
            "/api/projects/todou/issues/146/timeline",
            (_init: RequestInit, url: URL) =>
              url.searchParams.get("after") === "a0"
                ? {
                    items: blockEntries,
                    prev_cursor: null,
                    next_cursor: "a1",
                    has_more: false,
                  }
                : {
                    items: [],
                    prev_cursor: null,
                    next_cursor: null,
                    has_more: false,
                  },
          ],
          ...cardRoutes,
        ]);
        const result = await runCli(
          [...command, "--poll", "--since", "a0", ...(json ? ["--json"] : [])],
          { fetchImpl, env: loggedInEnv("todou") },
        );
        expect(result.exitCode).toBe(0);
        // Fetching the prefix/directory was already part of watch; block
        // events must not add a project-list request or read the other cards.
        expect(
          calls.filter((c) => new URL(c.url).pathname === "/api/projects"),
        ).toHaveLength(1);
        expect(issueReads(calls).map((read) => read.split("?")[0])).toEqual(
          command[0] === "issue"
            ? ["/api/projects/todou/issues/146/timeline"]
            : [],
        );
        expect(calls.some((c) => c.url.includes("/blocks"))).toBe(false);
        return result.stdout;
      };

      const human = await run(false);
      expect(human).toContain("T-146 User block_added (blocked by acme/9)");
      expect(human).toContain(
        "T-146 User block_removed (removed block on 7/10)",
      );
      expect(human).toContain(
        "T-146 User block_cleared (block by a card you cannot see cleared)",
      );
      expect(human).toContain(
        "T-146 User block_reblocked (block by acme/11 active again)",
      );
      expect(human).not.toContain("D-9");

      const json = await run(true);
      const { items, cursor, lines } = parseNdjson(json);
      expect(items).toEqual(
        blockEntries.map((entry) =>
          command[0] === "issue"
            ? entry
            : { ...entry, issue_ref: "T-146", project: "todou" },
        ),
      );
      expect(items[1]?.payload).not.toHaveProperty("other_project");
      expect(cursor.next_cursor).toBe("a1");
      expect(lines).toBe(blockEntries.length + 1);
      expect(json).not.toContain("a card you cannot see");
      expect(json).not.toContain("removed block on");
    },
  );
});

/** How a standing watch is stopped in a test: the drain turns fatal. */
const FATAL = { __status: 404, body: { code: "not_found", message: "gone" } };
const udsEnv = {
  ...loggedInEnv("todou"),
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/4242.sock",
};

describe("--follow=uds carries the cards too (T-286)", () => {
  /**
   * The push body is the one output a model reads without being able to go
   * and fetch anything itself, and it shares `renderHuman` with the one-shot
   * batch precisely so it cannot fall behind it.
   */
  it("pushes an opened card's title and body from a project watch", async () => {
    const clock = virtualClock();
    const push = fakePeerPush();
    const sse = sseStub();
    let next = 0;
    const replies: unknown[] = [
      {
        items: [{ ...opened(146), created_at: clock.iso() }],
        next_cursor: "a1",
      },
      { items: [], next_cursor: null },
      { items: [], next_cursor: null },
      { items: [], next_cursor: null },
    ];
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      ["GET", "/api/projects/todou/activity", () => replies[next++] ?? FATAL],
      ...cardRoutes,
    ]);

    const result = await runCli(
      [
        "watch",
        "-p",
        "todou",
        "--since",
        "a0",
        "--follow=uds",
        "--interval",
        "2",
        "--timeout",
        "300",
      ],
      { fetchImpl, env: udsEnv, clock, openPeerPush: push.open },
    );

    expect(result.exitCode).toBe(1);
    expect(push.pushes).toHaveLength(1);
    expect(push.pushes[0]?.body).toContain(`opened "${TITLE}"`);
    expect(push.pushes[0]?.body).toContain("  第二行");
  });

  it("pushes them from a single-card watch as well", async () => {
    const clock = virtualClock();
    const push = fakePeerPush();
    const sse = sseStub();
    let next = 0;
    const replies: unknown[] = [
      {
        items: [
          {
            ...referenced(146, {
              by_project_id: 2,
              by_issue: 281,
              by_comment: 4242,
            }),
            created_at: clock.iso(),
          },
        ],
        prev_cursor: null,
        next_cursor: "c1",
      },
      { items: [], prev_cursor: null, next_cursor: null },
      { items: [], prev_cursor: null, next_cursor: null },
      { items: [], prev_cursor: null, next_cursor: null },
    ];
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/issues/146/timeline",
        () => replies[next++] ?? FATAL,
      ],
      ...cardRoutes,
    ]);

    const result = await runCli(
      [
        "issue",
        "watch",
        "146",
        "--since",
        "c0",
        "--follow=uds",
        "--interval",
        "2",
        "--timeout",
        "300",
      ],
      { fetchImpl, env: udsEnv, clock, openPeerPush: push.open },
    );

    expect(result.exitCode).toBe(1);
    expect(push.pushes).toHaveLength(1);
    expect(push.pushes[0]?.body).toContain(
      `referenced (by T-281 "${REFERRER}" #comment-4242)`,
    );
  });
});
