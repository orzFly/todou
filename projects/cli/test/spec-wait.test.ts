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

  it("treats annotations outstanding on an unreviewed version as changes requested", async () => {
    const { run } = await settled(
      specInfo({ current_version: 3, unresolved_comments: 2 }),
    );
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

  it("drains without its own account, and without narrowing by type", async () => {
    const { routes } = wakesOnce();
    const { fetchImpl, calls } = fakeFetch(routes);
    await runCli(["spec", "wait", "23", "--debounce", "0"], {
      fetchImpl,
      env: loggedInEnv("proj"),
      clock: virtualClock(),
    });
    const drains = timelineDrains(calls);
    expect(drains.length).toBeGreaterThan(0);
    for (const url of drains) {
      // The whole account, so a sibling agent's entry never returns this
      // wait; per-session filtering would let it through.
      expect(url.searchParams.get("exclude_actor")).toBe("2");
      expect(url.searchParams.get("exclude_agent_session")).toBeNull();
      expect(url.searchParams.get("types")).toBeNull();
    }
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
