import { TodouClient } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { openChangeNudges } from "../src/change-nudges.ts";
import {
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  runCli,
  type SseStub,
  sseStub,
  virtualClock,
} from "./harness.ts";

const me = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};
const author = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};
const comment = (id: number, issue: number, createdAt: string) => ({
  type: "comment",
  id,
  author,
  body: `comment ${id}`,
  created_at: createdAt,
  edited_at: null,
  issue_number: issue,
});
const page = (items: unknown[], cursor: string | null) => ({
  items,
  next_cursor: cursor,
});
/** What the feed carries: a pointer, never the entry itself. */
const change = (project: string) => ({
  entity: "comment",
  id: 9,
  action: "created",
  issue_number: 3,
  project,
});

describe("change-feed nudges (T-123)", () => {
  const nudgesOver = async (sse: SseStub, issue?: number) => {
    const clock = virtualClock();
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/events", () => sse.reply()],
    ]);
    const nudges = await openChangeNudges({
      client: new TodouClient({
        baseUrl: "http://stub.test",
        token: "todou_pat_test",
        fetch: fetchImpl,
      }),
      projects: new Set(["todou"]),
      issue,
      intervalSec: 2,
      clock,
      random: () => 0,
    });
    return { nudges, clock };
  };

  it("returns the moment the feed reports a watched project", async () => {
    const sse = sseStub();
    sse.push("change", change("todou"));
    const { nudges, clock } = await nudgesOver(sse);
    await nudges.wait(600_000);
    expect(clock.elapsed()).toBe(0);
    nudges.close();
  });

  it("ignores projects outside the watch set", async () => {
    const sse = sseStub();
    sse.push("change", change("other"));
    const { nudges, clock } = await nudgesOver(sse);
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(5_000);
    sse.push("change", change("todou"));
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(5_000);
    nudges.close();
  });

  it("ignores another card's event once narrowed to one (T-208)", async () => {
    const sse = sseStub();
    sse.push("change", { ...change("todou"), issue_number: 99 });
    const { nudges, clock } = await nudgesOver(sse, 3);
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(5_000);
    sse.push("change", change("todou"));
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(5_000);
    nudges.close();
  });

  it("still wakes for an event that names no card (T-208)", async () => {
    const sse = sseStub();
    // A project-level action — a label, a status. Draining once and finding
    // nothing costs less than sleeping through something that mattered.
    sse.push("change", {
      entity: "label",
      id: 4,
      action: "created",
      project: "todou",
    });
    const { nudges, clock } = await nudgesOver(sse, 3);
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(0);
    nudges.close();
  });

  it("re-opens a feed that has gone silent past three heartbeats", async () => {
    const sse = sseStub();
    const { nudges, clock } = await nudgesOver(sse);
    await nudges.wait(600_000);
    // Capped at the stall bound, not at the caller's ten minutes: a
    // connection nothing has come out of is a connection to distrust.
    expect(clock.elapsed()).toBe(90_000);
    expect(sse.opens()).toBe(1);
    await nudges.wait(600_000);
    expect(sse.opens()).toBe(2);
    nudges.close();
  });

  it("treats a drop as one pull, then re-opens after a backoff", async () => {
    const sse = sseStub();
    const { nudges, clock } = await nudgesOver(sse);
    sse.drop();
    // The gap a drop leaves is the cursor's job, so recovery starts by
    // draining once — immediately, not on the next poll tick.
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(0);
    expect(sse.opens()).toBe(1);
    // Down, so the pace falls back to --interval …
    await nudges.wait(5_000);
    expect(clock.elapsed()).toBe(2_000);
    // … which is also when the backoff has run out.
    await nudges.wait(5_000);
    expect(sse.opens()).toBe(2);
    nudges.close();
  });

  it("polls forever, and asks once, when the server has no feed", async () => {
    const clock = virtualClock();
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/events", { __status: 404 }],
    ]);
    const nudges = await openChangeNudges({
      client: new TodouClient({ baseUrl: "", token: "t", fetch: fetchImpl }),
      projects: new Set(["todou"]),
      intervalSec: 2,
      clock,
    });
    await nudges.wait(600_000);
    await nudges.wait(600_000);
    expect(clock.elapsed()).toBe(4_000);
    expect(calls).toHaveLength(1);
    nudges.close();
  });

  it("retries an open that failed the way an outage fails", async () => {
    // 503 is transient, so the feed is worth asking for again — unlike the
    // 404 above, which says the endpoint is simply not there.
    const clock = virtualClock();
    const sse = sseStub();
    let attempts = 0;
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/events",
        () => (++attempts === 1 ? { __status: 503 } : sse.reply()),
      ],
    ]);
    const nudges = await openChangeNudges({
      client: new TodouClient({ baseUrl: "", token: "t", fetch: fetchImpl }),
      projects: new Set(["todou"]),
      intervalSec: 2,
      clock,
      random: () => 0,
    });
    expect(attempts).toBe(1);
    await nudges.wait(600_000); // still inside the backoff: poll pace
    expect(clock.elapsed()).toBe(2_000);
    expect(attempts).toBe(1);
    await nudges.wait(600_000);
    expect(attempts).toBe(2);
    nudges.close();
  });
});

describe("watch over the change feed, contract unchanged (T-123)", () => {
  const live = (clock: ReturnType<typeof virtualClock>) =>
    comment(9, 3, clock.iso());

  it("wakes on a pushed pointer instead of waiting out --interval", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    sse.push("change", change("todou"));
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("after") !== "a0") return page([], null);
          drains += 1;
          return drains === 1 ? page([], null) : page([live(clock)], "a1");
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
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    const { items, cursor } = parseNdjson<{
      issue_number: number;
      project: string;
    }>(result.stdout);
    expect(items[0]?.issue_number).toBe(3);
    expect(items[0]?.project).toBe("todou");
    expect(cursor.next_cursor).toBe("a1");
    // Not one interval was waited out: the second drain happened because
    // the feed asked for it.
    expect(clock.elapsed()).toBe(0);
    expect(drains).toBe(2);
  });

  it("keeps the T-121 self-filter on the drain the feed asked for", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    sse.push("change", change("todou"));
    let drains = 0;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("after") !== "a0") return page([], null);
          drains += 1;
          return drains === 1 ? page([], null) : page([live(clock)], "a1");
        },
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--since", "a0", "--timeout", "300", "--json"],
      {
        fetchImpl,
        env: {
          ...loggedInEnv(),
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "session-sentinel",
        },
        clock,
      },
    );
    expect(result.exitCode).toBe(0);
    // The feed knows nothing about actors, and never gets to decide what
    // counts as "not mine" — the drain still asks, on both axes.
    const drained = calls.filter((c) => c.url.includes("/activity"));
    expect(drained).toHaveLength(3); // empty, the nudged one, its terminator
    for (const call of drained) {
      expect(call.url).toContain("exclude_actor=2");
      expect(call.url).toContain("exclude_agent_session=session-sentinel");
    }
  });

  it("never treats the pointer as the entry: no push, no items", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    // A pointer for a project this watch does not follow, plus a project
    // that produced no activity row: neither may invent an entry.
    sse.push("change", change("other"));
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/activity",
        () => {
          drains += 1;
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
        "--interval",
        "2",
        "--timeout",
        "10",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe(
      `${JSON.stringify({
        type: "cursor",
        next_cursor: "a0",
        ref_format: { prefix: null, token: "#" },
      })}\n`,
    );
    expect(clock.elapsed()).toBe(10_000);
    // Idling on the feed rather than on a 2s tick: two drains, not six.
    expect(drains).toBe(2);
  });

  it("polls exactly as before against a server with no feed", async () => {
    const clock = virtualClock();
    let drains = 0;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", { __status: 404 }],
      [
        "GET",
        "/api/projects/todou/activity",
        () => {
          drains += 1;
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
        "--interval",
        "2",
        "--timeout",
        "10",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(3);
    expect(clock.elapsed()).toBe(10_000);
    expect(drains).toBe(6); // t = 0,2,4,6,8,10
    expect(calls.filter((c) => c.url.includes("/api/events"))).toHaveLength(1);
    // Silent: an old server is not the user's problem to hear about.
    expect(result.stderr).toBe("");
  });

  it("--poll never subscribes", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/projects/todou/activity", page([], null)],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv() },
    );
    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.url.includes("/api/events"))).toBe(false);
  });

  it("--debounce keeps its whole window, pulling early inside it", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    let tail = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          const after = url.searchParams.get("after");
          if (after === "a0") {
            // The burst's second entry announces itself while the first is
            // being handed over.
            sse.push("change", change("todou"));
            return page([live(clock)], "a1");
          }
          if (after !== "a1") return page([], null);
          tail += 1;
          return tail === 1
            ? page([], null)
            : page([comment(10, 4, clock.iso())], "a2");
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
    // The nudge pulled inside the window; it did not shorten it.
    expect(clock.elapsed()).toBe(60_000);
    expect(tail).toBe(2);
  });

  it("--all-projects reacts to whatever the feed carries", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    sse.push("change", change("a-project-not-named-anywhere"));
    let drains = 0;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/activity",
        () =>
          ++drains === 1
            ? page([], null)
            : page([{ ...live(clock), project: "elsewhere" }], "z1"),
      ],
    ]);
    const result = await runCli(
      [
        "watch",
        "--all-projects",
        "--since",
        "z0",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(clock.elapsed()).toBe(0);
    expect(parseNdjson(result.stdout).cursor.next_cursor).toBe("z1");
    // The watch set lives on the server under --all-projects, so nothing
    // is filtered client-side either.
    expect(calls.some((c) => c.url.includes("/api/events"))).toBe(true);
  });
});

describe("one-card waits over the change feed (T-208)", () => {
  const TIMELINE = "/api/projects/todou/issues/3/timeline";

  it("issue watch drains the moment the feed points at its card", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    sse.push("change", change("todou"));
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        TIMELINE,
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("after") !== "t0") return page([], null);
          drains += 1;
          return drains === 1
            ? page([], null)
            : page([comment(9, 3, clock.iso())], "t1");
        },
      ],
    ]);
    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "-p",
        "todou",
        "--since",
        "t0",
        "--interval",
        "2",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(parseNdjson(result.stdout).cursor.next_cursor).toBe("t1");
    // Not one interval waited out: the second drain happened because the
    // feed asked for it.
    expect(clock.elapsed()).toBe(0);
    expect(drains).toBe(2);
  });

  it("issue watch --poll never subscribes", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", TIMELINE, page([], null)],
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "-p", "todou", "--poll", "--since", "t0"],
      { fetchImpl, env: loggedInEnv(), clock: virtualClock() },
    );
    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.url.includes("/api/events"))).toBe(false);
  });

  it("question wait drains the moment the feed points at its card", async () => {
    const clock = virtualClock();
    const sse = sseStub();
    sse.push("change", change("todou"));
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        "/api/projects/todou/issues/3/questions",
        { items: [{ comment_id: 42, answer: null }], open: 1 },
      ],
      [
        "GET",
        TIMELINE,
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") {
            return { items: [], prev_cursor: null, next_cursor: "t0" };
          }
          if (url.searchParams.get("after") !== "t0") return page([], null);
          drains += 1;
          return drains === 1
            ? page([], null)
            : page(
                [
                  {
                    type: "event",
                    id: 7,
                    event_type: "question_answered",
                    actor: author,
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
                    created_at: clock.iso(),
                    agent_context: null,
                  },
                ],
                "t1",
              );
        },
      ],
    ]);
    const result = await runCli(
      [
        "question",
        "wait",
        "3",
        "42",
        "-p",
        "todou",
        "--interval",
        "3600",
        "--timeout",
        "300",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).comment_id).toBe(42);
    // An hour of --interval is what a poll would have charged for this.
    expect(clock.elapsed()).toBe(0);
    expect(drains).toBe(2);
  });
});
