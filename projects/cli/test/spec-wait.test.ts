import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  fakeFetch,
  loggedInEnv,
  type Route,
  runCli,
  sseStub,
  virtualClock,
} from "./harness.ts";

const SPEC_PATH = "/api/projects/proj/issues/23/spec";
const TIMELINE_PATH = "/api/projects/proj/issues/23/timeline";
const PUSH_PATH = "/api/projects/proj/issues/23/spec/push";
const ME = {
  id: 2,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
  owner: null,
};
const AUTHOR = {
  id: 5,
  login: "user",
  display_name: "User",
  kind: "human",
  owner: null,
};

const specInfo = (over: Record<string, unknown> = {}) => ({
  current_version: 2,
  current_version_cursor: "cv2",
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "plan.md", size: 12 }],
  versions: [
    {
      number: 2,
      author: ME,
      message: "plan v2",
      created_at: "2026-08-11T11:00:00.000Z",
    },
  ],
  ...over,
});

const comment = (id: number, body: string, createdAt: string) => ({
  type: "comment",
  id,
  author: AUTHOR,
  body,
  created_at: createdAt,
  edited_at: null,
});

/** One drained page; `has_more: false` ends the drain on a non-empty page. */
const page = (items: unknown[], cursor: string | null) => ({
  items,
  next_cursor: cursor,
  has_more: false,
});

const dirs: string[] = [];
function specDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "todou-spec-wait-"));
  dirs.push(dir);
  writeFileSync(join(dir, "plan.md"), "# plan\n");
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The last line of stdout is the outcome, whatever came before it. */
const outcomeOf = (stdout: string) => stdout.trimEnd().split("\n").at(-1) ?? "";

const timelineDrains = (calls: { url: string }[]) =>
  calls
    .map((call) => new URL(call.url, "http://stub.test"))
    .filter(
      (url) =>
        url.pathname === TIMELINE_PATH && url.searchParams.get("last") === null,
    );

describe("spec wait: the verdict that is already in", () => {
  const settled = async (info: Record<string, unknown>) => {
    const { fetchImpl, calls } = fakeFetch([["GET", SPEC_PATH, info]]);
    const run = await runCli(["spec", "wait", "23"], {
      fetchImpl,
      env: loggedInEnv("proj"),
    });
    return { run, calls };
  };

  it("returns an approval without ever watching", async () => {
    const { run, calls } = await settled(
      specInfo({ review_status: "approved" }),
    );
    expect(run.exitCode).toBe(0);
    expect(outcomeOf(run.stdout)).toBe("approved · spec v2");
    // The re-entry position is printed even here, so a reader always has one.
    expect(run.stdout).toContain("cursor: cv2 (spec wait 23 --since <cursor>)");
    expect(timelineDrains(calls)).toHaveLength(0);
    expect(calls.some((c) => c.url.includes("/api/events"))).toBe(false);
  });

  it("names the unresolved count with a request-changes verdict", async () => {
    const { run } = await settled(
      specInfo({
        current_version: 3,
        review_status: "changes_requested",
        unresolved_comments: 2,
      }),
    );
    expect(outcomeOf(run.stdout)).toBe(
      "changes requested · spec v3 · 2 unresolved annotations",
    );
  });

  it("treats annotations carried onto an unreviewed version as changes requested", async () => {
    const { run } = await settled(
      specInfo({
        current_version: 3,
        unresolved_comments: 2,
        unresolved_carried_comments: 2,
      }),
    );
    expect(outcomeOf(run.stdout)).toBe(
      "changes requested · spec v3 · 2 unresolved annotations carried over — no new verdict",
    );
  });

  it("names both counts when only some annotations were carried", async () => {
    const { run } = await settled(
      specInfo({
        current_version: 3,
        unresolved_comments: 3,
        unresolved_carried_comments: 2,
      }),
    );
    expect(outcomeOf(run.stdout)).toBe(
      "changes requested · spec v3 · 3 unresolved annotations, 2 carried over — no new verdict",
    );
  });

  it("falls back to the whole count on a server that reports no carry", async () => {
    const { unresolved_carried_comments: _unreported, ...legacy } = specInfo({
      current_version: 3,
      unresolved_comments: 2,
    });
    const { run } = await settled(legacy);
    expect(outcomeOf(run.stdout)).toBe(
      "changes requested · spec v3 · 2 unresolved annotations carried over — no new verdict",
    );
  });

  it("lets an approval win over an annotation left open", async () => {
    const { run } = await settled(
      specInfo({ review_status: "approved", unresolved_comments: 1 }),
    );
    expect(outcomeOf(run.stdout)).toBe(
      "approved · spec v2 · 1 unresolved annotation",
    );
  });
});

describe("spec wait: blocking", () => {
  /** Routes that answer one foreign comment on the second drain. */
  const wakesOnce = (
    info: Record<string, unknown> = specInfo(),
    extra: Route[] = [],
  ): { routes: Route[]; drains: () => number } => {
    let drains = 0;
    return {
      drains: () => drains,
      routes: [
        ["GET", "/api/me", ME],
        ["GET", SPEC_PATH, () => info],
        [
          "GET",
          TIMELINE_PATH,
          (_init: RequestInit, url: URL) => {
            if (url.searchParams.get("last") === "1") return page([], "tail");
            drains += 1;
            return drains >= 2
              ? page(
                  [comment(41, "这里的措辞再想想", "2026-08-11T12:00:00.000Z")],
                  "c41",
                )
              : page([], null);
          },
        ],
        ...extra,
      ],
    };
  };

  it("prints the entry, the cursor and the feedback outcome", async () => {
    const clock = virtualClock();
    const { routes } = wakesOnce();
    const { fetchImpl } = fakeFetch(routes);
    const run = await runCli(
      ["spec", "wait", "23", "--debounce", "0", "--interval", "2"],
      { fetchImpl, env: loggedInEnv("proj"), clock },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("这里的措辞再想想");
    expect(run.stdout).toContain("cursor: c41 (spec wait 23 --since <cursor>)");
    expect(outcomeOf(run.stdout)).toBe("feedback · no verdict on spec v2 yet");
  });

  /**
   * A reference is the entry whose whole point is the card it came from, and
   * this wait is read by an agent that cannot go and look it up (T-286).
   */
  it("names the card a reference came from", async () => {
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo()],
      ["GET", "/api/projects", [{ id: 4, slug: "proj" }]],
      ["GET", "/api/projects/proj/references/config", { format: {} }],
      [
        "GET",
        "/api/projects/proj/issues",
        { items: [{ number: 9, title: "把游标语义写进 usage" }] },
      ],
      [
        "GET",
        TIMELINE_PATH,
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") return page([], "tail");
          drains += 1;
          return drains >= 2
            ? page(
                [
                  {
                    type: "event",
                    id: 71,
                    event_type: "referenced",
                    actor: AUTHOR,
                    payload: { by_project_id: 4, by_issue: 9, by_comment: 88 },
                    created_at: "2026-08-11T12:00:00.000Z",
                  },
                ],
                "c71",
              )
            : page([], null);
        },
      ],
    ]);
    const run = await runCli(
      ["spec", "wait", "23", "--debounce", "0", "--interval", "2"],
      { fetchImpl, env: loggedInEnv("proj"), clock: virtualClock() },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      'referenced (by #9 "把游标语义写进 usage" #comment-88)',
    );
  });

  it("starts where the current version was pushed, not at now", async () => {
    const { routes } = wakesOnce();
    const { fetchImpl, calls } = fakeFetch(routes);
    const run = await runCli(["spec", "wait", "23", "--debounce", "0"], {
      fetchImpl,
      env: loggedInEnv("proj"),
      clock: virtualClock(),
    });
    expect(run.exitCode).toBe(0);
    expect(timelineDrains(calls)[0]?.searchParams.get("after")).toBe("cv2");
    // "Now" is what the fallback would have used; the point is it did not.
    expect(
      calls.some(
        (c) =>
          new URL(c.url, "http://stub.test").searchParams.get("last") === "1",
      ),
    ).toBe(false);
  });

  it("resumes from --since when the caller holds a cursor", async () => {
    const { routes } = wakesOnce();
    const { fetchImpl, calls } = fakeFetch(routes);
    await runCli(["spec", "wait", "23", "--since", "mine", "--debounce", "0"], {
      fetchImpl,
      env: loggedInEnv("proj"),
      clock: virtualClock(),
    });
    expect(timelineDrains(calls)[0]?.searchParams.get("after")).toBe("mine");
  });

  it("falls back to the tail cursor, and says so, on a server without the field", async () => {
    const info = specInfo();
    delete (info as { current_version_cursor?: string }).current_version_cursor;
    const { routes } = wakesOnce(info);
    const { fetchImpl, calls } = fakeFetch(routes);
    const run = await runCli(["spec", "wait", "23", "--debounce", "0"], {
      fetchImpl,
      env: loggedInEnv("proj"),
      clock: virtualClock(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      "does not report where the current version was pushed",
    );
    expect(timelineDrains(calls)[0]?.searchParams.get("after")).toBe("tail");
    // Re-read after taking that cursor: state read before it could not have
    // seen a verdict that landed in between.
    const specReads = calls.filter(
      (c) => new URL(c.url, "http://stub.test").pathname === SPEC_PATH,
    );
    expect(specReads.length).toBeGreaterThanOrEqual(3);
  });

  it("drains without its own session, and without narrowing by type", async () => {
    const { routes } = wakesOnce();
    const { fetchImpl, calls } = fakeFetch(routes);
    await runCli(["spec", "wait", "23", "--debounce", "0"], {
      fetchImpl,
      env: {
        ...loggedInEnv("proj"),
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "session-sentinel",
      },
      clock: virtualClock(),
    });
    const drains = timelineDrains(calls);
    expect(drains.length).toBeGreaterThan(0);
    for (const url of drains) {
      // Both axes, the pair `issue watch` uses: the session names this
      // waiter, the account catches entries claiming no session at all.
      // Filtering the whole account would hide a sibling agent's
      // no-verdict review, which is the one this wait exists to hear
      // (T-277).
      expect(url.searchParams.get("exclude_actor")).toBe("2");
      expect(url.searchParams.get("exclude_agent_session")).toBe(
        "session-sentinel",
      );
      expect(url.searchParams.get("types")).toBeNull();
    }
  });

  // T-277. Annotations anchored to the current version can only come from a
  // review that judged nothing, so they must not settle the wait as a
  // revision round — the pusher would then never reach the user's verdict.
  it("keeps blocking with annotations on the current version, then says feedback", async () => {
    const { routes, drains } = wakesOnce(
      specInfo({ unresolved_comments: 3, unresolved_carried_comments: 0 }),
    );
    const { fetchImpl } = fakeFetch(routes);
    const run = await runCli(["spec", "wait", "23", "--debounce", "0"], {
      fetchImpl,
      env: loggedInEnv("proj"),
      clock: virtualClock(),
    });
    expect(run.exitCode).toBe(0);
    // It blocked rather than judging off the count: the second drain is
    // what returned it.
    expect(drains()).toBeGreaterThan(1);
    expect(outcomeOf(run.stdout)).toBe("feedback · no verdict on spec v2 yet");
  });

  it("wakes on a sibling session's no-verdict review of the same account", async () => {
    // The fleet shares one machine account, so this entry's author is the
    // waiting account itself — only the session tells them apart.
    const siblingReview = {
      type: "event",
      id: 77,
      event_type: "spec_review",
      actor: ME,
      created_at: "2026-08-11T12:05:00.000Z",
      payload: {
        version: 2,
        verdict: "comment",
        comment_id: null,
        annotation_count: 2,
      },
    };
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo({ unresolved_comments: 2 })],
      [
        "GET",
        TIMELINE_PATH,
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") return page([], "tail");
          drains += 1;
          return drains >= 2 ? page([siblingReview], "e77") : page([], null);
        },
      ],
    ]);
    const run = await runCli(["spec", "wait", "23", "--debounce", "0"], {
      fetchImpl,
      env: {
        ...loggedInEnv("proj"),
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "mine",
      },
      clock: virtualClock(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("commented");
    expect(run.stdout).toContain("2 annotation(s)");
    expect(outcomeOf(run.stdout)).toBe("feedback · no verdict on spec v2 yet");
  });

  it("heartbeats through a quiet phase instead of giving up", async () => {
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo()],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          return drains >= 6
            ? page([comment(42, "ok", "2026-08-11T12:10:00.000Z")], "c42")
            : page([], null);
        },
      ],
    ]);
    const run = await runCli(
      [
        "spec",
        "wait",
        "23",
        "--timeout",
        "4",
        "--interval",
        "2",
        "--debounce",
        "0",
      ],
      { fetchImpl, env: loggedInEnv("proj"), clock: virtualClock() },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain(
      "still waiting for a verdict — nothing new in 4s",
    );
    expect(outcomeOf(run.stdout)).toBe("feedback · no verdict on spec v2 yet");
  });

  it("drains the moment the change feed points at the card", async () => {
    const sse = sseStub();
    const clock = virtualClock();
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo()],
      ["GET", "/api/events", () => sse.reply()],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          return drains >= 2
            ? page([comment(43, "approved", "2026-08-11T12:00:00.000Z")], "c43")
            : page([], null);
        },
      ],
    ]);
    // Queued before the first open, so it arrives with the opening hello.
    sse.push("change", {
      entity: "timeline",
      id: 9,
      action: "created",
      issue_number: 23,
      project: "proj",
    });
    const run = await runCli(
      ["spec", "wait", "23", "--interval", "3600", "--debounce", "0"],
      { fetchImpl, env: loggedInEnv("proj"), clock },
    );
    expect(run.exitCode).toBe(0);
    // Waiting out one --interval would have charged an hour of virtual time.
    expect(clock.elapsed()).toBeLessThan(3_600_000);
    expect(sse.opens()).toBe(1);
  });
});

describe("spec push --wait", () => {
  const pushRoute = (over: Record<string, unknown> = {}): Route => [
    "POST",
    PUSH_PATH,
    {
      unchanged: false,
      version: 3,
      added: [],
      changed: ["plan.md"],
      removed: [],
      cursor: "pc3",
      ...over,
    },
  ];

  it("waits from the push's own cursor and ends on the outcome", async () => {
    let drains = 0;
    const { fetchImpl, calls } = fakeFetch([
      pushRoute(),
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo({ current_version: 3 })],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          return drains >= 2
            ? page([comment(44, "再改一处", "2026-08-11T12:00:00.000Z")], "c44")
            : page([], null);
        },
      ],
    ]);
    const run = await runCli(
      [
        "spec",
        "push",
        "23",
        specDir(),
        "--message",
        "v3",
        "--wait",
        "--debounce",
        "0",
      ],
      { fetchImpl, env: loggedInEnv("proj"), clock: virtualClock() },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("spec v3 pushed:");
    expect(outcomeOf(run.stdout)).toBe("feedback · no verdict on spec v3 yet");
    expect(timelineDrains(calls)[0]?.searchParams.get("after")).toBe("pc3");
    // One cursor line for the whole gate, and it is the position to resume
    // from — the push's own has been consumed by the wake-up.
    expect(run.stdout.match(/^cursor: /gm)).toHaveLength(1);
    expect(run.stdout).toContain("cursor: c44 (spec wait 23 --since <cursor>)");
  });

  it("returns the standing verdict when the push changed nothing", async () => {
    const { fetchImpl, calls } = fakeFetch([
      pushRoute({ unchanged: true, version: 2, changed: [], cursor: "pc2" }),
      ["GET", SPEC_PATH, specInfo({ review_status: "approved" })],
    ]);
    const run = await runCli(["spec", "push", "23", specDir(), "--wait"], {
      fetchImpl,
      env: loggedInEnv("proj"),
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("no changes — spec stays at v2");
    expect(outcomeOf(run.stdout)).toBe("approved · spec v2");
    expect(timelineDrains(calls)).toHaveLength(0);
    // The case where both lines would have carried the same cursor.
    expect(run.stdout.match(/^cursor: /gm)).toHaveLength(1);
  });

  it("refuses --print-cursor before pushing anything", async () => {
    const { fetchImpl, calls } = fakeFetch([pushRoute()]);
    const run = await runCli(
      ["spec", "push", "23", specDir(), "--wait", "--print-cursor"],
      { fetchImpl, env: loggedInEnv("proj") },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("--wait and --print-cursor both want stdout");
    expect(calls).toHaveLength(0);
  });

  it("refuses the wait's timing flags without --wait", async () => {
    const { fetchImpl, calls } = fakeFetch([pushRoute()]);
    const run = await runCli(
      ["spec", "push", "23", specDir(), "--debounce", "30"],
      { fetchImpl, env: loggedInEnv("proj") },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("--debounce only means something with --wait");
    expect(calls).toHaveLength(0);
  });

  it("streams NDJSON under --json, push first and outcome last", async () => {
    const { fetchImpl } = fakeFetch([
      pushRoute(),
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo({ current_version: 3 })],
      [
        "GET",
        TIMELINE_PATH,
        () =>
          page(
            [comment(45, "one more thing", "2026-08-11T12:00:00.000Z")],
            "c45",
          ),
      ],
    ]);
    const run = await runCli(
      ["spec", "push", "23", specDir(), "--wait", "--json", "--debounce", "0"],
      { fetchImpl, env: loggedInEnv("proj"), clock: virtualClock() },
    );
    expect(run.exitCode).toBe(0);
    const records = run.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line, i) => {
        try {
          return JSON.parse(line) as { type: string };
        } catch {
          throw new Error(`stdout line ${i + 1} is not JSON: ${line}`);
        }
      });
    expect(records.map((r) => r.type)).toEqual([
      "push",
      "comment",
      "cursor",
      "outcome",
    ]);
    expect(records[0]).toMatchObject({ version: 3, cursor: "pc3" });
    expect(records.at(-1)).toMatchObject({
      outcome: "feedback",
      review_status: "unreviewed",
      unresolved_comments: 0,
      version: 3,
    });
  });
});

describe("spec wait: withdrawal and replacement versions", () => {
  const sessionEnv = {
    ...loggedInEnv("proj"),
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "waiting-session",
  };

  it.each([false, true])(
    "returns an existing withdrawal before carried comments (json=%s)",
    async (json) => {
      const { fetchImpl, calls } = fakeFetch([
        [
          "GET",
          SPEC_PATH,
          specInfo({
            review_status: "withdrawn",
            unresolved_comments: 3,
            unresolved_carried_comments: 2,
          }),
        ],
      ]);
      const run = await runCli(
        ["spec", "wait", "23", ...(json ? ["--json"] : [])],
        { fetchImpl, env: sessionEnv },
      );
      expect(run.exitCode).toBe(0);
      expect(timelineDrains(calls)).toHaveLength(0);
      if (json) {
        const records = run.stdout
          .trim()
          .split("\n")
          .map((s) => JSON.parse(s));
        expect(records.map((r) => r.type)).toEqual(["cursor", "outcome"]);
        expect(records[0]).toMatchObject({ next_cursor: "cv2" });
        expect(records[1]).toMatchObject({
          outcome: "withdrawn",
          review_status: "withdrawn",
          version: 2,
          unresolved_comments: 3,
          carried_comments: 2,
        });
      } else {
        expect(outcomeOf(run.stdout)).toBe("withdrawn · spec v2 · reworking");
        expect(run.stdout).toContain("cursor: cv2");
        expect(run.stdout).not.toContain("changes requested");
        expect(run.stdout).not.toContain("approved");
      }
    },
  );

  it.each(["poll", "sse", "disconnect"])(
    "observes a same-session withdrawal with an empty timeline via %s",
    async (transport) => {
      const sse = sseStub();
      const clock = virtualClock();
      let drains = 0;
      const changedAt = transport === "disconnect" ? 3 : 2;
      const { fetchImpl, calls } = fakeFetch([
        ["GET", "/api/me", ME],
        [
          "GET",
          SPEC_PATH,
          () =>
            specInfo({
              review_status: drains >= changedAt ? "withdrawn" : "unreviewed",
            }),
        ],
        [
          "GET",
          "/api/events",
          () =>
            transport === "poll"
              ? new Response(null, { status: 404 })
              : sse.reply(),
        ],
        [
          "GET",
          TIMELINE_PATH,
          () => {
            drains += 1;
            if (drains > 4)
              throw new Error("same-session state was never observed");
            if (drains === 1 && transport === "disconnect") sse.drop();
            return page([], null);
          },
        ],
      ]);
      if (transport === "sse") {
        sse.push("change", {
          entity: "spec",
          id: 23,
          action: "updated",
          project: "proj",
          issue_number: 23,
        });
      }
      const run = await runCli(
        ["spec", "wait", "23", "--json", "--interval", "2", "--debounce", "30"],
        { fetchImpl, env: sessionEnv, clock },
      );
      expect(
        drains,
        "state-only withdrawal must stop after its confirming drain",
      ).toBe(changedAt + 1);
      expect(run.exitCode, `${run.stderr}\n${run.stdout}`).toBe(0);
      const records = run.stdout
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(records.map((r) => r.type)).toEqual(["cursor", "outcome"]);
      expect(records[0]).toMatchObject({ next_cursor: "cv2" });
      expect(records[1]).toMatchObject({
        outcome: "withdrawn",
        review_status: "withdrawn",
        version: 2,
      });
      for (const url of timelineDrains(calls)) {
        expect(url.searchParams.get("after")).toBe("cv2");
        expect(url.searchParams.get("exclude_agent_session")).toBe(
          "waiting-session",
        );
        expect(url.searchParams.get("exclude_actor")).toBe("2");
      }
      if (transport === "poll") expect(clock.elapsed()).toBe(2000);
      if (transport === "disconnect") {
        expect(clock.elapsed()).toBeGreaterThanOrEqual(2000);
      }
      if (transport === "sse") {
        expect(clock.elapsed()).toBe(0);
        expect(sse.opens()).toBe(1);
      }
    },
  );

  it.each([ME, AUTHOR])(
    "delivers withdrawal activity from $login before cursor and outcome",
    async (actor) => {
      const clock = virtualClock();
      let drains = 0;
      const { fetchImpl } = fakeFetch([
        ["GET", "/api/me", ME],
        [
          "GET",
          SPEC_PATH,
          () =>
            specInfo({ review_status: drains ? "withdrawn" : "unreviewed" }),
        ],
        [
          "GET",
          TIMELINE_PATH,
          () => {
            drains += 1;
            if (drains > 5)
              throw new Error("withdrawal bypassed debounce deadline");
            if (drains === 1) {
              return page(
                [
                  {
                    type: "event",
                    id: 81,
                    event_type: "spec_withdrawn",
                    actor,
                    agent_context: {
                      agent: "claude-code",
                      session_id: "sibling-session",
                    },
                    created_at: clock.iso(),
                    payload: { version: 2, reason: "Reconsider the approach" },
                  },
                ],
                "e81",
              );
            }
            return drains === 2
              ? page([comment(82, "Keep the old API", clock.iso())], "c82")
              : page([], null);
          },
        ],
      ]);
      const run = await runCli(
        ["spec", "wait", "23", "--json", "--debounce", "4", "--interval", "2"],
        { fetchImpl, env: sessionEnv, clock },
      );
      expect(run.exitCode).toBe(0);
      expect(clock.elapsed()).toBe(4000);
      const records = run.stdout
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(records.map((r) => r.type)).toEqual([
        "event",
        "comment",
        "cursor",
        "outcome",
      ]);
      expect(records[0]).toMatchObject({ event_type: "spec_withdrawn", actor });
      expect(records[2]).toMatchObject({ next_cursor: "c82" });
      expect(records[3]).toMatchObject({ outcome: "withdrawn", version: 2 });
    },
  );

  it.each(["unreviewed", "approved", "changes_requested", "withdrawn"])(
    "returns latest %s when withdrawal is immediately followed by a new version",
    async (reviewStatus) => {
      let drains = 0;
      let postDrainReads = 0;
      const { fetchImpl } = fakeFetch([
        ["GET", "/api/me", ME],
        [
          "GET",
          SPEC_PATH,
          () => {
            if (!drains) return specInfo();
            postDrainReads += 1;
            return postDrainReads === 1
              ? specInfo({ review_status: "withdrawn" })
              : specInfo({
                  current_version: 3,
                  current_version_cursor: "cv3",
                  review_status: reviewStatus,
                  unresolved_comments: 2,
                  unresolved_carried_comments: 2,
                });
          },
        ],
        [
          "GET",
          TIMELINE_PATH,
          () => {
            drains += 1;
            if (drains > 3)
              throw new Error("withdrawal failed to stop the wait");
            return page([], null);
          },
        ],
      ]);
      const run = await runCli(["spec", "wait", "23", "--json"], {
        fetchImpl,
        env: sessionEnv,
        clock: virtualClock(),
      });
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(outcomeOf(run.stdout))).toMatchObject({
        outcome: reviewStatus === "unreviewed" ? "feedback" : reviewStatus,
        review_status: reviewStatus,
        version: 3,
        carried_comments: 2,
      });
    },
  );

  it("observes a replacement even when the withdrawn intermediate state was missed", async () => {
    let drains = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", ME],
      ["GET", SPEC_PATH, () => specInfo(drains ? { current_version: 3 } : {})],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          if (drains > 3)
            throw new Error("new version failed to settle the wait");
          return page([], null);
        },
      ],
    ]);
    const run = await runCli(["spec", "wait", "23", "--json"], {
      fetchImpl,
      env: sessionEnv,
      clock: virtualClock(),
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(outcomeOf(run.stdout))).toMatchObject({
      outcome: "feedback",
      review_status: "unreviewed",
      version: 3,
    });
  });

  it.each(["withdrawn", "unreviewed"])(
    "push --wait reports latest %s after a resubmission race",
    async (reviewStatus) => {
      const { fetchImpl } = fakeFetch([
        [
          "POST",
          PUSH_PATH,
          {
            unchanged: false,
            version: 3,
            cursor: "pc3",
            added: [],
            changed: [],
            removed: [],
          },
        ],
        [
          "GET",
          SPEC_PATH,
          specInfo({
            current_version: reviewStatus === "unreviewed" ? 4 : 3,
            review_status: reviewStatus,
            unresolved_comments: 2,
            unresolved_carried_comments: 2,
          }),
        ],
      ]);
      const run = await runCli(
        ["spec", "push", "23", specDir(), "--wait", "--json"],
        { fetchImpl, env: sessionEnv },
      );
      expect(run.exitCode).toBe(0);
      const records = run.stdout
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(records.map((r) => r.type)).toEqual(["push", "cursor", "outcome"]);
      expect(records[1]).toMatchObject({ next_cursor: "pc3" });
      expect(records[2]).toMatchObject({
        outcome: reviewStatus === "unreviewed" ? "feedback" : "withdrawn",
        review_status: reviewStatus,
        version: reviewStatus === "unreviewed" ? 4 : 3,
        carried_comments: 2,
      });
    },
  );

  it("rechecks an initially withdrawn version before returning a newer unreviewed result", async () => {
    let reads = 0;
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        SPEC_PATH,
        () => {
          reads += 1;
          return reads === 1
            ? specInfo({ review_status: "withdrawn" })
            : specInfo({
                current_version: 3,
                unresolved_carried_comments: 2,
                unresolved_comments: 2,
              });
        },
      ],
    ]);
    const run = await runCli(["spec", "wait", "23", "--json"], {
      fetchImpl,
      env: sessionEnv,
    });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(outcomeOf(run.stdout))).toMatchObject({
      outcome: "feedback",
      review_status: "unreviewed",
      version: 3,
    });
  });

  it.each(["timeline", "state", "final state"])(
    "retries a transient %s failure without losing or repeating delivered entries",
    async (failureAt) => {
      let drains = 0;
      let stateReads = 0;
      const { fetchImpl, calls } = fakeFetch([
        ["GET", "/api/me", ME],
        [
          "GET",
          SPEC_PATH,
          () => {
            stateReads += 1;
            if (
              (failureAt === "state" && stateReads === 2) ||
              (failureAt === "final state" && stateReads === 3)
            )
              return {
                __status: 503,
                body: { error: "unavailable", message: "try again" },
              };
            return specInfo({
              review_status: drains ? "withdrawn" : "unreviewed",
            });
          },
        ],
        [
          "GET",
          TIMELINE_PATH,
          () => {
            drains += 1;
            if (failureAt === "timeline" && drains === 1) {
              return {
                __status: 503,
                body: { error: "unavailable", message: "try again" },
              };
            }
            return page(
              [comment(83, "Rework this", "2026-08-11T12:00:00.000Z")],
              "c83",
            );
          },
        ],
      ]);
      const run = await runCli(
        ["spec", "wait", "23", "--json", "--debounce", "0"],
        { fetchImpl, env: sessionEnv, clock: virtualClock() },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toContain("transient failure");
      expect(
        timelineDrains(calls).map((url) => url.searchParams.get("after")),
      ).toEqual(failureAt === "final state" ? ["cv2"] : ["cv2", "cv2"]);
      const records = run.stdout
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      expect(records.map((r) => r.type)).toEqual([
        "comment",
        "cursor",
        "outcome",
      ]);
      expect(records[0]).toMatchObject({ id: 83 });
      expect(records[1]).toMatchObject({ next_cursor: "c83" });
      expect(records[2]).toMatchObject({ outcome: "withdrawn", version: 2 });
    },
  );

  it("retries a state-only read without inventing activity or advancing the resume cursor", async () => {
    let drains = 0;
    let reads = 0;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", ME],
      [
        "GET",
        SPEC_PATH,
        () => {
          reads += 1;
          if (reads === 2) {
            return {
              __status: 503,
              body: { error: "unavailable", message: "try again" },
            };
          }
          return specInfo({
            review_status: drains ? "withdrawn" : "unreviewed",
          });
        },
      ],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          if (drains > 3) throw new Error("empty withdrawal failed to settle");
          return page([], null);
        },
      ],
    ]);
    const run = await runCli(
      ["spec", "wait", "23", "--since", "resume", "--json"],
      { fetchImpl, env: sessionEnv, clock: virtualClock() },
    );
    expect(run.exitCode).toBe(0);
    expect(
      timelineDrains(calls).map((url) => url.searchParams.get("after")),
    ).toEqual(["resume", "resume", "resume"]);
    const records = run.stdout
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    expect(records.map((r) => r.type)).toEqual(["cursor", "outcome"]);
    expect(records[0]).toMatchObject({ next_cursor: "resume" });
    expect(records[1]).toMatchObject({ outcome: "withdrawn" });
  });

  it("emits no cursor or outcome when the post-drain state read permanently fails", async () => {
    let reads = 0;
    const { fetchImpl, calls } = fakeFetch([
      ["GET", "/api/me", ME],
      [
        "GET",
        SPEC_PATH,
        () => {
          reads += 1;
          return reads === 1
            ? specInfo()
            : {
                __status: 403,
                body: { error: "forbidden", message: "access revoked" },
              };
        },
      ],
      [
        "GET",
        TIMELINE_PATH,
        page(
          [
            comment(
              84,
              "Not delivered without state",
              "2026-08-11T12:00:00.000Z",
            ),
          ],
          "c84",
        ),
      ],
    ]);
    const run = await runCli(
      ["spec", "wait", "23", "--json", "--debounce", "0"],
      {
        fetchImpl,
        env: sessionEnv,
        clock: virtualClock(),
      },
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(reads).toBe(2);
    expect(timelineDrains(calls)).toHaveLength(1);
  });

  it("push --wait observes a live same-session withdrawal and prints one cursor", async () => {
    let drains = 0;
    const { fetchImpl, calls } = fakeFetch([
      [
        "POST",
        PUSH_PATH,
        {
          unchanged: false,
          version: 3,
          cursor: "pc3",
          added: [],
          changed: [],
          removed: [],
        },
      ],
      ["GET", "/api/me", ME],
      [
        "GET",
        SPEC_PATH,
        () =>
          specInfo({
            current_version: 3,
            review_status: drains >= 2 ? "withdrawn" : "unreviewed",
          }),
      ],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          if (drains > 3)
            throw new Error("push waiter ignored its session's withdrawal");
          return page([], null);
        },
      ],
    ]);
    const run = await runCli(
      ["spec", "push", "23", specDir(), "--wait", "--interval", "2"],
      { fetchImpl, env: sessionEnv, clock: virtualClock() },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("spec v3 pushed:");
    expect(run.stdout.match(/^cursor: /gm)).toHaveLength(1);
    expect(outcomeOf(run.stdout)).toBe("withdrawn · spec v3 · reworking");
    expect(
      timelineDrains(calls).map((url) => url.searchParams.get("after")),
    ).toEqual(["pc3", "pc3", "pc3"]);
  });

  it("delivers a foreign withdrawal committed between the empty drain and state read", async () => {
    let drains = 0;
    const clock = virtualClock();
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", ME],
      [
        "GET",
        SPEC_PATH,
        () =>
          specInfo({
            review_status: drains ? "withdrawn" : "unreviewed",
          }),
      ],
      [
        "GET",
        TIMELINE_PATH,
        () => {
          drains += 1;
          if (drains > 5)
            throw new Error("confirmation never delivered the withdrawal");
          return drains === 2
            ? page(
                [
                  {
                    type: "event",
                    id: 85,
                    event_type: "spec_withdrawn",
                    actor: AUTHOR,
                    created_at: clock.iso(),
                    payload: { version: 2, reason: "Recheck the scope" },
                  },
                ],
                "e85",
              )
            : page([], null);
        },
      ],
    ]);
    const run = await runCli(
      ["spec", "wait", "23", "--debounce", "4", "--interval", "2"],
      { fetchImpl, env: sessionEnv, clock },
    );
    expect(run.exitCode).toBe(0);
    expect(clock.elapsed()).toBe(4000);
    expect(run.stdout).toContain("Recheck the scope");
    expect(run.stdout).toContain("cursor: e85");
    expect(outcomeOf(run.stdout)).toBe("withdrawn · spec v2 · reworking");
  });
});
