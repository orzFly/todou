import { describe, expect, it } from "vitest";
import {
  fakeFetch,
  loggedInEnv,
  parseNdjson,
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
const other = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};
const status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#6b7280",
  position: 0,
  is_default: false,
};
const listItem = (number: number, title: string) => ({
  id: number * 10,
  number,
  title,
  status,
  author: other,
  assignees: [],
  labels: [],
  created_at: "2026-08-11T10:00:00Z",
  updated_at: "2026-08-11T11:00:00Z",
  body_edited_at: null,
});
const issuePage = {
  items: [
    { ...listItem(3, "Fix the potato"), unread: true },
    { ...listItem(4, "Water the field"), unread: false },
  ],
  next_cursor: null,
};
const webComment = {
  type: "comment",
  id: 9,
  author: other,
  body: "web comment",
  created_at: "2026-08-11T12:00:00Z",
  edited_at: null,
  issue_number: 3,
};
const page = (items: unknown[], next: string | null) => ({
  items,
  next_cursor: next,
});

describe("unread markers (server state)", () => {
  const env = loggedInEnv("todou");

  // fakeFetch throws on unregistered routes, so these tests passing with
  // only /issues mocked also proves list no longer scans /activity or /me.
  it("renders ● from the list response's unread field", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", issuePage],
    ]);
    const result = await runCli(["issue", "list"], { fetchImpl, env });
    expect(result.exitCode).toBe(0);
    const line3 = result.stdout.split("\n").find((l) => l.includes("#3"));
    const line4 = result.stdout.split("\n").find((l) => l.includes("#4"));
    expect(line3).toContain("●");
    expect(line4).not.toContain("●");
  });

  it("renders ● (+N) when the server reports unread comments (T-77)", async () => {
    const countedPage = {
      items: [
        { ...listItem(3, "Fix the potato"), unread: true, unread_comments: 3 },
        // Event-only activity: unread without a comment count keeps the dot.
        { ...listItem(4, "Water the field"), unread: true, unread_comments: 0 },
        {
          ...listItem(5, "Plant more rows"),
          unread: false,
          unread_comments: 0,
        },
      ],
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", countedPage],
    ]);
    const result = await runCli(["issue", "list"], { fetchImpl, env });
    expect(result.exitCode).toBe(0);
    const line = (n: number) =>
      result.stdout.split("\n").find((l) => l.includes(`#${n}`));
    expect(line(3)).toContain("● (+3)");
    expect(line(4)).toContain("●");
    expect(line(4)).not.toContain("(+");
    expect(line(5)).not.toContain("●");
  });

  it("--unread filters to unread items", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", issuePage],
    ]);
    const filtered = await runCli(["issue", "list", "--unread", "--json"], {
      fetchImpl,
      env,
    });
    const parsed = JSON.parse(filtered.stdout) as {
      items: Array<{ number: number }>;
    };
    expect(parsed.items.map((i) => i.number)).toEqual([3]);
  });

  it("issue view advances the read position to the newest shown entry", async () => {
    const issue = { ...listItem(3, "Fix the potato"), body: "" };
    let putBody: unknown;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      [
        "GET",
        "/api/projects/todou/issues/3/timeline",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "t1"
            ? page([], null)
            : { items: [webComment], prev_cursor: null, next_cursor: "t1" },
      ],
      [
        "PUT",
        "/api/projects/todou/issues/3/read",
        (init: RequestInit) => {
          putBody = JSON.parse(String(init.body));
          return { __status: 204 };
        },
      ],
    ]);
    const viewed = await runCli(["issue", "view", "3"], { fetchImpl, env });
    expect(viewed.exitCode).toBe(0);
    expect(putBody).toEqual({ up_to: webComment.created_at });
  });

  it("issue view on an empty timeline marks read at server-now", async () => {
    const issue = { ...listItem(3, "Fix the potato"), body: "" };
    let putBody: unknown;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page([], null)],
      [
        "PUT",
        "/api/projects/todou/issues/3/read",
        (init: RequestInit) => {
          putBody = JSON.parse(String(init.body));
          return { __status: 204 };
        },
      ],
    ]);
    const viewed = await runCli(["issue", "view", "3"], { fetchImpl, env });
    expect(viewed.exitCode).toBe(0);
    expect(putBody).toEqual({});
  });

  it("degrades silently on servers without read state", async () => {
    // Pre-T-46 list rows carry no unread field at all.
    const oldPage = {
      items: [listItem(3, "Fix the potato"), listItem(4, "Water the field")],
      next_cursor: null,
    };
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/projects/todou/issues", oldPage],
    ]);
    const listed = await runCli(["issue", "list"], { fetchImpl, env });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).not.toContain("●");
    const filtered = await runCli(["issue", "list", "--unread"], {
      fetchImpl,
      env,
    });
    expect(filtered.stdout).toBe("no unread issues\n");

    const issue = { ...listItem(3, "Fix the potato"), body: "" };
    const { fetchImpl: viewFetch } = fakeFetch([
      ["GET", "/api/projects/todou/issues/3", issue],
      ["GET", "/api/projects/todou/issues/3/timeline", page([], null)],
      [
        "PUT",
        "/api/projects/todou/issues/3/read",
        {
          __status: 404,
          body: { error: { code: "not_found", message: "no such route" } },
        },
      ],
    ]);
    const viewed = await runCli(["issue", "view", "3"], {
      fetchImpl: viewFetch,
      env,
    });
    expect(viewed.exitCode).toBe(0);
    expect(viewed.stdout).toContain("#3 Fix the potato");
  });
});

describe("watch (project-level)", () => {
  it("excludes the current user by default and tags issue numbers", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? page([webComment], "a1")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{ issue_number: number }>(
      result.stdout,
    );
    expect(items[0]?.issue_number).toBe(3);
    expect(cursor.next_cursor).toBe("a1");
    const activityCall = calls.find((c) => c.url.includes("/activity"));
    expect(activityCall?.url).toContain("exclude_actor=2");
    // No harness, no session to name: the account is the whole answer.
    expect(activityCall?.url).not.toContain("exclude_agent_session");
  });

  it("renders issue numbers for humans", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? page([webComment], "a1")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.stdout).toContain("#3 User commented");
    expect(result.stdout).toContain("web comment");
    expect(result.stdout).toContain("cursor: a1");
  });

  /**
   * The failure T-175 was filed for: a stream that names the entry type and
   * stops there is one whose reader never learns what was said. A comment
   * showing its body is the acceptance criterion, not a nicety.
   */
  it("shows the start of a comment body, one line per entry", async () => {
    const instruction =
      "要在 dogfood 上开——先把 CLI 发布到镜像里\n\n然后再回来说一声";
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? page(
                [
                  { ...webComment, body: instruction },
                  {
                    type: "event",
                    id: 12,
                    event_type: "status_changed",
                    actor: other,
                    payload: { from: { name: "Todo" }, to: { name: "Next" } },
                    created_at: "2026-08-11T12:00:01Z",
                    issue_number: 4,
                  },
                ],
                "a1",
              )
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("要在 dogfood 上开——先把 CLI 发布到镜像里");
    // Folded onto its line: the second paragraph rides along, no wrapping.
    expect(lines[0]).toContain("然后再回来说一声");
    expect(lines[1]).toMatch(/^#4 User status_changed \(Todo → Next\) /);
    expect(lines[2]).toBe("cursor: a1");
  });

  it("--summary caps how much body a line carries", async () => {
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("after") === "a0"
            ? page([{ ...webComment, body: "0123456789abcdefghij" }], "a1")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--summary", "10"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.stdout.split("\n")[0]).toMatch(/: 0123456789…$/);
  });

  it("--debounce batches a cross-issue burst into one wake-up", async () => {
    const clock = virtualClock();
    // Live entry: created_at is the clock's own now, so the full window
    // applies — the anchor is `created_at`, not first sight.
    const liveComment = { ...webComment, created_at: clock.iso() };
    let a1Calls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "a0") return page([liveComment], "a1");
          if (after === "a1") {
            a1Calls += 1;
            return a1Calls === 1
              ? page([], null)
              : page(
                  [
                    {
                      ...liveComment,
                      id: 10,
                      body: "second card",
                      issue_number: 4,
                    },
                  ],
                  "a2",
                );
          }
          return page([], null);
        },
      ],
    ]);
    const result = await runCli(
      [
        "watch",
        "-p",
        "todou",
        "--since",
        "a0",
        "--debounce",
        "60",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{ issue_number: number }>(
      result.stdout,
    );
    expect(items.map((i) => i.issue_number)).toEqual([3, 4]);
    expect(cursor.next_cursor).toBe("a2");
    // The whole window is honored — the second card lands on the second
    // poll, yet the loop keeps collecting to the end instead of returning
    // early. Virtual seconds, so a sentinel-sized window costs no wall time.
    expect(clock.elapsed()).toBe(60_000);
  });

  it("--any-actor skips /me and the actor filter; bootstrap uses last=1", async () => {
    const { fetchImpl, calls } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) =>
          url.searchParams.get("last") === "1"
            ? page([], "a0")
            : page([], null),
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--any-actor", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(3);
    expect(parseNdjson(result.stdout).cursor.next_cursor).toBe("a0");
    expect(calls.some((c) => c.url.includes("/api/me"))).toBe(false);
    expect(calls.some((c) => c.url.includes("exclude_actor"))).toBe(false);
    expect(calls.some((c) => c.url.includes("exclude_agent_session"))).toBe(
      false,
    );
  });

  it("filters its own agent session, not its whole account (T-121)", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/projects/todou/activity", page([], null)],
      ["GET", "/api/activity", { items: [], next_cursor: null }],
    ]);
    const harnessEnv = {
      ...loggedInEnv(),
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "session-sentinel",
    };
    for (const argv of [
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      ["watch", "-p", "todou,other", "--poll", "--since", "a0", "--json"],
    ]) {
      const result = await runCli(argv, { fetchImpl, env: harnessEnv });
      expect(result.exitCode).toBe(3);
    }
    // Both axes ride along on both endpoints: the session names this
    // watcher, the account catches entries claiming no session at all.
    const filtered = calls.filter((c) => c.url.includes("activity"));
    expect(filtered).toHaveLength(2);
    for (const call of filtered) {
      expect(call.url).toContain("exclude_actor=2");
      expect(call.url).toContain("exclude_agent_session=session-sentinel");
    }
  });
});
