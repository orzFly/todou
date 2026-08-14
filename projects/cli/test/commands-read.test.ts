import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCliConfig, saveCliConfig } from "../src/config.ts";
import {
  fakeFetch,
  loggedInEnv,
  type Route,
  runCli,
  virtualClock,
} from "./harness.ts";

const me = {
  id: 2,
  login: "claude",
  display_name: "Claude",
  kind: "machine",
  owner: null,
};
const statuses = [
  { id: 1, name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { id: 2, name: "Done", category: "closed", color: "#22c55e", position: 1 },
];
const labels = [{ id: 7, name: "bug", color: "#ef4444" }];
const issue = {
  id: 11,
  number: 3,
  title: "Fix the potato",
  body: "It sprouted.",
  status: statuses[0],
  author: me,
  assignees: [me],
  labels,
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
};

describe("whoami", () => {
  it("prints identity, and raw JSON under --json", async () => {
    const { fetchImpl } = fakeFetch([["GET", "/api/me", me]]);
    const human = await runCli(["whoami"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe("claude (Claude) · machine @ http://stub.test\n");

    const json = await runCli(["whoami", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(JSON.parse(json.stdout)).toEqual(me);
  });

  it("fails with guidance when no server is configured", async () => {
    const result = await runCli(["whoami"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no server configured");
    expect(result.stderr).toContain("todou login");
  });

  it("fails with guidance when the server has no token", async () => {
    const result = await runCli(["whoami"], {
      env: { TODOU_SERVER: "http://stub.test" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not logged in to http://stub.test");
  });
});

describe("project list", () => {
  it("renders a slug/name table", async () => {
    const projects = [
      { id: 1, slug: "dogfood", name: "Dogfood", description: "sandbox" },
    ];
    const { fetchImpl } = fakeFetch([["GET", "/api/projects", projects]]);
    const result = await runCli(["project", "list"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.stdout).toBe("dogfood  Dogfood  sandbox\n");
  });
});

describe("issue list", () => {
  it("resolves filter names to ids in the query", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", statuses],
      ["GET", "/api/projects/todou/labels", labels],
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
    ]);
    const result = await runCli(
      ["issue", "list", "--status", "todo", "--label", "bug", "--limit", "5"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const listCall = calls.find((c) => c.url.includes("/issues?"));
    const url = new URL(listCall?.url ?? "", "http://stub.test");
    expect(url.searchParams.get("status")).toBe("1");
    expect(url.searchParams.get("label")).toBe("7");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(result.stdout).toContain("#3");
    expect(result.stdout).toContain("Fix the potato");
  });

  it("maps --open/--closed to the category param and rejects combos", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues", { items: [], next_cursor: null }],
    ]);
    const result = await runCli(["issue", "list", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toBe("no issues\n");
    expect(calls[0]?.url).toContain("category=closed");

    const combo = await runCli(["issue", "list", "--open", "--closed"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(combo.exitCode).toBe(1);
    expect(combo.stderr).toContain("mutually exclusive");
  });

  it("requires a project", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "list"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no project selected");
    expect(result.stderr).toContain("todou project link");
  });
});

describe("issue view", () => {
  const timelinePages = [
    {
      items: [
        {
          type: "comment",
          id: 1,
          author: me,
          body: "first",
          created_at: "2026-08-11T10:30:00Z",
          edited_at: null,
        },
      ],
      prev_cursor: null,
      next_cursor: "c1",
    },
    {
      items: [
        {
          type: "event",
          id: 2,
          event_type: "status_changed",
          actor: me,
          payload: {
            from: { id: 1, name: "Todo" },
            to: { id: 2, name: "Done" },
          },
          created_at: "2026-08-11T10:45:00Z",
        },
      ],
      prev_cursor: "c1",
      next_cursor: null,
    },
  ];

  it("stitches the full timeline across pages", async () => {
    let page = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          const reply = timelinePages[page];
          page += 1;
          return reply;
        },
      ],
    ]);
    const result = await runCli(["issue", "view", "3", "--json"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      issue: { number: number };
      timeline: unknown[];
      next_cursor: string | null;
    };
    expect(parsed.issue.number).toBe(3);
    expect(parsed.timeline).toHaveLength(2);
    // The tail cursor rides along so a follow-up watch can --since it.
    expect(parsed.next_cursor).toBe("c1");
  });

  it("renders body, comments, and events for humans", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", timelinePages[1]],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("#3 Fix the potato");
    expect(result.stdout).toContain("It sprouted.");
    expect(result.stdout).toContain("status_changed (Todo → Done)");
  });

  it("spells out event payloads and appends spec command hints", async () => {
    const event = (id: number, event_type: string, payload: unknown) => ({
      type: "event",
      id,
      event_type,
      actor: me,
      payload,
      created_at: "2026-08-11T10:45:00Z",
    });
    const page = {
      items: [
        event(1, "label_added", {
          label: { id: 7, name: "bug", color: "#ef4444" },
        }),
        event(2, "assigned", { user: { id: 2, login: "claude" } }),
        event(3, "referenced", { by_issue: 9, by_comment: 41 }),
        event(4, "attachment_added", {
          attachment: { id: 5, filename: "shot.png", size: 123 },
        }),
        event(5, "spec_pushed", {
          version: 2,
          message: "tighten scope",
          added: ["plan.md"],
          changed: ["design.md", "api.md"],
          removed: [],
        }),
        event(6, "spec_review", {
          version: 2,
          verdict: "request_changes",
          comment_id: null,
          annotation_count: 4,
        }),
        event(7, "spec_comments_resolved", {
          comment_ids: [11, 12],
          paths: ["design.md"],
        }),
        event(8, "closed", { from: null, to: { id: 2, name: "Done" } }),
        event(9, "spec_review", {
          version: 3,
          verdict: "approve",
          comment_id: null,
          annotation_count: 0,
        }),
      ],
      prev_cursor: null,
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page],
      [
        "GET",
        "/api/projects/todou/references/config",
        { format: { prefix: "T", history: [] }, autolinks: [] },
      ],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("label_added (bug)");
    expect(result.stdout).toContain("assigned (@claude)");
    expect(result.stdout).toContain("referenced (by T-9)");
    expect(result.stdout).toContain("attachment_added (shot.png)");
    expect(result.stdout).toContain(
      "spec_pushed (v2: 1 added, 2 changed — tighten scope · use `todou spec pull 3 --version 2 <empty-dir>` to view)",
    );
    expect(result.stdout).toContain(
      "spec_review (v2 changes requested, 4 annotation(s) · use `todou spec comments 3 --unresolved` to view)",
    );
    expect(result.stdout).toContain(
      "spec_review (v3 approved · use `todou spec pull 3 --version 3 <empty-dir>` to view)",
    );
    expect(result.stdout).toContain(
      "spec_comments_resolved (2 annotation(s) on design.md)",
    );
    expect(result.stdout).toContain("closed (? → Done)");
  });

  it("renders renames and edited markers", async () => {
    const page = {
      items: [
        {
          type: "comment",
          id: 1,
          author: me,
          body: "first",
          created_at: "2026-08-11T10:30:00Z",
          edited_at: "2026-08-11T10:40:00Z",
        },
        {
          type: "event",
          id: 2,
          event_type: "title_changed",
          actor: me,
          payload: { from: "Old potato", to: "Fix the potato" },
          created_at: "2026-08-11T10:45:00Z",
        },
      ],
      prev_cursor: null,
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page],
    ]);
    const result = await runCli(["issue", "view", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toContain("commented (edited)");
    expect(result.stdout).toContain('renamed "Old potato" → "Fix the potato"');
    expect(result.stdout).not.toContain("title_changed (");
  });

  it("rejects a non-numeric issue number", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(["issue", "view", "abc"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("positive integer");
  });

  it("accepts the show alias, project/number refs, and issue URLs", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", timelinePages[1]],
    ]);
    const viaShow = await runCli(["issue", "show", "3"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(viaShow.exitCode).toBe(0);
    expect(viaShow.stdout).toContain("#3 Fix the potato");

    // no TODOU_PROJECT here: the ref itself supplies the project
    const viaRef = await runCli(["issue", "view", "todou/3"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(viaRef.exitCode).toBe(0);
    expect(viaRef.stdout).toContain("#3 Fix the potato");

    const viaUrl = await runCli(
      ["issue", "view", "http://stub.test/projects/todou/issues/3"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(viaUrl.exitCode).toBe(0);

    const agreeing = await runCli(["issue", "view", "todou/3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(agreeing.exitCode).toBe(0);
  });

  it("rejects a ref contradicting -p, and a URL on a foreign server", async () => {
    const { fetchImpl } = fakeFetch([]);
    const conflict = await runCli(
      ["issue", "view", "dogfood/3", "-p", "todou"],
      {
        fetchImpl,
        env: loggedInEnv(),
      },
    );
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain('says project "dogfood"');

    const elsewhere = await runCli(
      ["issue", "view", "https://other.example/projects/todou/issues/3"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(elsewhere.exitCode).toBe(1);
    expect(elsewhere.stderr).toContain("active server");
  });
});

describe("issue watch", () => {
  const newComment = {
    type: "comment",
    id: 9,
    author: me,
    body: "fresh news",
    created_at: "2026-08-11T12:00:00Z",
    edited_at: null,
  };
  const pageWith = (items: unknown[], next: string | null) => ({
    items,
    prev_cursor: null,
    next_cursor: next,
  });
  // Every watch resolves "me" first: the default self-filter needs the
  // account axis for entries no agent session claims (T-121).
  const watchFetch = (routes: Route[]) =>
    fakeFetch([["GET", "/api/me", me], ...routes]);

  it("--poll returns new entries and the advanced cursor (exit 0)", async () => {
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "c0"
            ? pageWith([newComment], "c1")
            : pageWith([], null),
      ],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ body: string }>;
      next_cursor: string;
    };
    expect(parsed.items.map((i) => i.body)).toEqual(["fresh news"]);
    expect(parsed.next_cursor).toBe("c1");
  });

  it("--poll with nothing new echoes the cursor and exits 3", async () => {
    const { fetchImpl } = watchFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--json"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.stdout) as { next_cursor: string };
    expect(parsed.next_cursor).toBe("c0");
  });

  it("without --since it baselines at now, then blocks until news", async () => {
    const clock = virtualClock();
    let forwardPolls = 0;
    const { fetchImpl, calls } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") {
            return pageWith([{ ...newComment, id: 1, body: "old" }], "tail");
          }
          if (url.searchParams.get("after") === "tail") {
            forwardPolls += 1;
            return forwardPolls >= 3
              ? pageWith([newComment], "c2")
              : pageWith([], null);
          }
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--interval", "2", "--timeout", "300", "--json"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ body: string }>;
      next_cursor: string;
    };
    // History before the baseline is never replayed.
    expect(parsed.items.map((i) => i.body)).toEqual(["fresh news"]);
    expect(parsed.next_cursor).toBe("c2");
    expect(calls.some((c) => c.url.includes("last=1"))).toBe(true);
    // Two empty polls at the requested interval, then the news — the
    // cadence is the flag's, not the machine's.
    expect(clock.elapsed()).toBe(4_000);
  });

  it("times out with exit 3 when nothing happens", async () => {
    const clock = virtualClock();
    const { fetchImpl } = watchFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--timeout",
        "60",
        "--interval",
        "2",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("no new activity");
    expect(result.stdout).toContain("cursor: c0");
    // The last sleep is clamped to the remaining time, so the quiet phase
    // ends on the deadline rather than one interval past it.
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--debounce batches entries arriving inside the window", async () => {
    const clock = virtualClock();
    // Live entry: created_at is the clock's own now, so the full window
    // applies — the anchor is `created_at`, not first sight.
    const liveComment = { ...newComment, created_at: clock.iso() };
    let c1Calls = 0;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "c0") return pageWith([liveComment], "c1");
          if (after === "c1") {
            c1Calls += 1;
            // Quiet at first; a second entry lands during the window.
            return c1Calls === 1
              ? pageWith([], null)
              : pageWith([{ ...liveComment, id: 10, body: "late news" }], "c2");
          }
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--debounce",
        "60",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ body: string }>;
      next_cursor: string;
    };
    expect(parsed.items.map((i) => i.body)).toEqual([
      "fresh news",
      "late news",
    ]);
    expect(parsed.next_cursor).toBe("c2");
    // The window is honored: no early return on the first entry.
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--debounce window is fixed, so sustained activity still returns", async () => {
    const clock = virtualClock();
    let n = 0;
    let pending = true;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        () => {
          // Every drain finds one fresh entry: item page, then empty page.
          if (pending) {
            pending = false;
            n += 1;
            return pageWith(
              [
                {
                  ...newComment,
                  id: n,
                  body: `burst ${n}`,
                  created_at: clock.iso(),
                },
              ],
              `b${n}`,
            );
          }
          pending = true;
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "b0",
        "--debounce",
        "60",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: unknown[];
      next_cursor: string;
    };
    // Ever-fresh entries never push the anchor forward: the window still
    // closes 60s after the *first* batch, so the count is exactly the
    // opening drain plus one per 2s poll inside it.
    expect(parsed.items).toHaveLength(1 + 60 / 2);
    expect(parsed.next_cursor).toBe(`b${n}`);
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--debounce returns at once when a resume back-fills an aged batch", async () => {
    const clock = virtualClock();
    const staleComment = { ...newComment, created_at: clock.iso(-60_000) };
    let c1Calls = 0;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "c0") return pageWith([staleComment], "c1");
          if (after === "c1") c1Calls += 1;
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--debounce",
        "5",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    // The window (created_at + 5s) ended long before the watch saw the
    // entry, so it is delivered without idle waiting or re-polling.
    expect(clock.elapsed()).toBe(0);
    expect(c1Calls).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ body: string }>;
      next_cursor: string;
    };
    expect(parsed.items.map((i) => i.body)).toEqual(["fresh news"]);
    expect(parsed.next_cursor).toBe("c1");
  });

  it("--debounce waits only the remainder of a partially aged window", async () => {
    const clock = virtualClock();
    const agedComment = { ...newComment, created_at: clock.iso(-1_000) };
    let c1Calls = 0;
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "c0") return pageWith([agedComment], "c1");
          if (after === "c1") {
            c1Calls += 1;
            return c1Calls === 1
              ? pageWith([], null)
              : pageWith(
                  [
                    {
                      ...newComment,
                      id: 10,
                      body: "late news",
                      created_at: clock.iso(),
                    },
                  ],
                  "c2",
                );
          }
          return pageWith([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--debounce",
        "2",
        "--interval",
        "0.5",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      items: Array<{ body: string }>;
      next_cursor: string;
    };
    // Still inside the window, so collection continues...
    expect(parsed.items.map((i) => i.body)).toEqual([
      "fresh news",
      "late news",
    ]);
    expect(parsed.next_cursor).toBe("c2");
    // ...but 1s of the 2s window was spent before the watch saw the entry:
    // exactly the remainder is waited, not a fresh window.
    expect(clock.elapsed()).toBe(1_000);
  });

  it("--poll ignores --debounce and returns immediately", async () => {
    const clock = virtualClock();
    const { fetchImpl } = watchFetch([
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "c0"
            ? pageWith([newComment], "c1")
            : pageWith([], null),
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--poll",
        "--since",
        "c0",
        "--debounce",
        "5",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(
      (JSON.parse(result.stdout) as { items: unknown[] }).items,
    ).toHaveLength(1);
    expect(clock.elapsed()).toBe(0);
  });

  it("passes --type through and resolves --exclude-actor me", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "c0"
            ? pageWith([newComment], "c1")
            : pageWith([], null),
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--poll",
        "--since",
        "c0",
        "--type",
        "comment,status_changed",
        "--exclude-actor",
        "me",
      ],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(0);
    const timelineCall = calls.find((c) => c.url.includes("/timeline"));
    expect(timelineCall?.url).toContain("types=comment%2Cstatus_changed");
    expect(timelineCall?.url).toContain("exclude_actor=2");
  });

  it("applies the same self-filter as todou watch (T-121)", async () => {
    const { fetchImpl, calls } = watchFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0"],
      {
        fetchImpl,
        env: {
          ...loggedInEnv("todou"),
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "session-sentinel",
        },
      },
    );
    expect(result.exitCode).toBe(3);
    const timelineCall = calls.find((c) => c.url.includes("/timeline"));
    expect(timelineCall?.url).toContain("exclude_actor=2");
    expect(timelineCall?.url).toContain(
      "exclude_agent_session=session-sentinel",
    );
  });

  it("--any-actor keeps everything and skips /me", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3/timeline", pageWith([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--any-actor"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(3);
    expect(calls.some((c) => c.url.includes("/api/me"))).toBe(false);
    expect(calls.some((c) => c.url.includes("exclude_"))).toBe(false);
  });

  it("refuses --any-actor together with --exclude-actor", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--any-actor", "--exclude-actor", "me"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--any-actor conflicts with");
  });

  it("rejects unknown --type values before calling the server", async () => {
    const { fetchImpl } = fakeFetch([]);
    const result = await runCli(
      ["issue", "watch", "3", "--poll", "--type", "bogus"],
      { fetchImpl, env: loggedInEnv("todou") },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown --type "bogus"');
  });
});

describe("status/label list", () => {
  it("prints statuses ordered by position", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/statuses", [statuses[1], statuses[0]]],
    ]);
    const result = await runCli(["status", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout.indexOf("Todo")).toBeLessThan(
      result.stdout.indexOf("Done"),
    );
  });

  it("marks the project's default status", async () => {
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/statuses",
        [{ ...statuses[0], is_default: true }, statuses[1]],
      ],
    ]);
    const result = await runCli(["status", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    const todoLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("Todo"));
    expect(todoLine).toContain("default");
    expect(result.stdout).not.toContain("Done  closed  #22c55e  default");
  });

  it("prints labels", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/labels", labels],
    ]);
    const result = await runCli(["label", "list"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.stdout).toBe("bug  #ef4444\n");
  });
});

describe("project link/unlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "todou-link-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("errors helpfully outside a repository", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou", { id: 1, slug: "todou" }],
    ]);
    const result = await runCli(["project", "link", "todou"], {
      fetchImpl,
      env: { ...loggedInEnv(), XDG_CONFIG_HOME: dir },
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no usable git remote");
  });

  it("link verifies the slug and writes the binding; unlink removes it", async () => {
    const repo = join(dir, "repo");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "git@example.com:me/potato.git",
    ]);

    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou", { id: 1, slug: "todou" }],
    ]);
    const env = { ...loggedInEnv(), XDG_CONFIG_HOME: dir };
    const linked = await runCli(["project", "link", "todou"], {
      fetchImpl,
      env,
      cwd: repo,
    });
    expect(linked.exitCode).toBe(0);
    expect(loadCliConfig(env).bindings).toEqual([
      {
        remote: "git@example.com:me/potato.git",
        server: "http://stub.test",
        project: "todou",
      },
    ]);

    const unlinked = await runCli(["project", "unlink"], { env, cwd: repo });
    expect(unlinked.exitCode).toBe(0);
    expect(loadCliConfig(env).bindings).toEqual([]);
  });

  it("unlink reports a missing binding", async () => {
    saveCliConfig({ servers: {}, bindings: [] }, { XDG_CONFIG_HOME: dir });
    const result = await runCli(["project", "unlink"], {
      env: { XDG_CONFIG_HOME: dir },
      cwd: dir,
    });
    expect(result.exitCode).toBe(1);
    expect(loadCliConfig({ XDG_CONFIG_HOME: dir }).bindings).toEqual([]);
  });
});

describe("reference format display (T-80)", () => {
  const config = {
    format: {
      prefix: "T",
      history: [{ prefix: "T", effective_from: "2026-08-13T00:00:00Z" }],
    },
    autolinks: [],
  };

  it("spells the view header with the project prefix", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        { items: [], prev_cursor: null, next_cursor: null },
      ],
      ["PUT", "/api/projects/todou/issues/3/read", {}],
      ["GET", "/api/projects/todou/references/config", config],
    ]);
    const result = await runCli(["issue", "view", "T-3", "-p", "todou"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("T-3 Fix the potato");
    expect(result.stdout).not.toContain("#3");
  });

  it("spells list rows with the prefix and degrades without the endpoint", async () => {
    const page = { items: [issue], next_cursor: null };
    const withConfig = fakeFetch([
      ["GET", "/api/projects/todou/issues", page],
      ["GET", "/api/projects/todou/references/config", config],
    ]);
    const spelled = await runCli(["issue", "list", "-p", "todou"], {
      fetchImpl: withConfig.fetchImpl,
      env: loggedInEnv(),
    });
    expect(spelled.stdout).toContain("T-3");

    // Old server: no config route — fakeFetch throws, the CLI degrades.
    const without = fakeFetch([["GET", "/api/projects/todou/issues", page]]);
    const fallback = await runCli(["issue", "list", "-p", "todou"], {
      fetchImpl: without.fetchImpl,
      env: loggedInEnv(),
    });
    expect(fallback.exitCode).toBe(0);
    expect(fallback.stdout).toContain("#3");
  });

  it("skips the config fetch entirely under --json", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues",
        { items: [issue], next_cursor: null },
      ],
    ]);
    const result = await runCli(["issue", "list", "-p", "todou", "--json"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(0);
    expect(
      calls.some((c) => String(c.url).includes("/references/config")),
    ).toBe(false);
  });
});
