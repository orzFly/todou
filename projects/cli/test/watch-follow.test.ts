import { describe, expect, it } from "vitest";
import { runWatchLoop } from "../src/watch-loop.ts";
import { fakePeerPush } from "./fake-peer-push.ts";
import {
  fakeFetch,
  loggedInEnv,
  runCli,
  type SseStub,
  sseStub,
  virtualClock,
} from "./harness.ts";

const entry = (createdAt: string) => ({ created_at: createdAt });

describe("runWatchLoop standing mode (T-252)", () => {
  it("keeps waiting after a batch until afterItems says stop", async () => {
    const clock = virtualClock();
    const batches: Array<{ items: unknown[]; cursor: string | undefined }> = [];
    let drains = 0;
    const code = await runWatchLoop({
      poll: false,
      forever: true,
      timeoutSec: 600,
      intervalSec: 2,
      baseline: "c0",
      clock,
      drain: () => {
        drains += 1;
        return Promise.resolve({
          items: [entry(clock.iso())],
          cursor: `c${drains}`,
        });
      },
      onItems: (items, cursor) => batches.push({ items, cursor }),
      afterItems: async () => (batches.length < 3 ? "continue" : "stop"),
      onEmpty: () => {
        throw new Error("every drain had something");
      },
    });

    // Three batches out of one call: the whole point — an agent that would
    // otherwise have spent a tool call re-opening the watch twice.
    expect(code).toBe(0);
    expect(drains).toBe(3);
    expect(batches.map((b) => b.cursor)).toEqual(["c1", "c2", "c3"]);
  });

  it("stops at the top of a round, before draining again", async () => {
    // What makes a refused push noticed during the quiet phase rather than
    // whenever the next batch happens to land — which may be hours off.
    const clock = virtualClock();
    let stop = false;
    let drains = 0;
    const code = await runWatchLoop({
      poll: false,
      forever: true,
      timeoutSec: 600,
      intervalSec: 2,
      baseline: "c0",
      clock,
      drain: () => {
        drains += 1;
        return Promise.resolve({ items: [], cursor: "c0" });
      },
      onItems: () => {
        throw new Error("nothing was there to deliver");
      },
      shouldStop: () => stop,
      // Stands in for the wait a rejection wakes: the reason to stop
      // arrives while the loop is idling, not while it is draining.
      wait: async () => {
        stop = true;
      },
      onEmpty: () => {
        throw new Error("a standing watch does not report emptiness");
      },
    });

    expect(code).toBe(0);
    expect(drains).toBe(1);
  });

  it("leaves the one-shot contract alone when neither hook is given", async () => {
    let drains = 0;
    const code = await runWatchLoop({
      poll: false,
      timeoutSec: 600,
      intervalSec: 2,
      baseline: "c0",
      clock: virtualClock(),
      drain: () => {
        drains += 1;
        return Promise.resolve({
          items: [entry("2026-08-11T12:00:00Z")],
          cursor: "c1",
        });
      },
      onItems: () => {},
      onEmpty: () => {},
    });
    expect(code).toBe(0);
    expect(drains).toBe(1);
  });
});

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
const change = {
  entity: "comment",
  id: 9,
  action: "created",
  project: "todou",
};

/** How a standing watch is stopped in a test: the drain turns fatal. */
const FATAL = { __status: 404, body: { code: "not_found", message: "gone" } };

/**
 * The route table every command-level case here drains through: one reply
 * per activity request, in order, and a fatal 404 once the script runs out —
 * which is how a standing watch is stopped when nothing refuses it.
 *
 * Written out request by request, terminator pages included: a non-empty
 * page carrying a next_cursor makes `drainPaged` ask once more, so a batch
 * always costs two requests and a script keyed on the cursor alone would
 * quietly answer the wrong one.
 */
function activityRoutes(replies: unknown[]) {
  let next = 0;
  const sse: SseStub = sseStub();
  const { fetchImpl, calls } = fakeFetch([
    ["GET", "/api/me", me],
    ["GET", "/api/events", () => sse.reply()],
    ["GET", "/api/projects/todou/activity", () => replies[next++] ?? FATAL],
  ]);
  const drains = () => calls.filter((c) => c.url.includes("/activity")).length;
  return { sse, fetchImpl, calls, drains };
}

/** A batch page and the empty page that terminates its pagination. */
const batch = (items: unknown[], cursor: string) => [
  page(items, cursor),
  page([], null),
];
const quiet = page([], null);

const bodyLines = (stdout: string) =>
  stdout.split("\n").filter((line) => line !== "");

describe("watch --follow=stdout (T-252)", () => {
  it("delivers every batch instead of exiting with the first", async () => {
    const clock = virtualClock();
    const { sse, fetchImpl } = activityRoutes([
      ...batch([comment(9, 3, clock.iso())], "a1"),
      quiet,
      ...batch([comment(10, 4, clock.iso())], "a2"),
      // Past here the script runs out and the drain turns fatal, which is
      // the only off switch a standing watch nothing refuses has.
    ]);
    // Already latched when the first quiet phase starts, so the second
    // batch is drained because the feed asked for it rather than because
    // --interval elapsed — which is what `clock.elapsed()` below proves.
    sse.push("change", change);

    const result = await runCli(
      [
        "watch",
        "-p",
        "todou",
        "--since",
        "a0",
        "--follow",
        "--debounce",
        "0",
        "--interval",
        "2",
        "--timeout",
        "300",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );

    expect(result.exitCode).toBe(1);
    // Two whole batches, each closing with the range it covers — and each
    // batch's `since` is the previous batch's `cursor`.
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "since: a0",
      "cursor: a1",
      expect.stringContaining("comment 10"),
      "since: a1",
      "cursor: a2",
    ]);
    expect(clock.elapsed()).toBe(0);
  });
});

describe("watch --follow=uds (T-252)", () => {
  const udsEnv = {
    ...loggedInEnv(),
    CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/4242.sock",
  };

  it("writes nothing to stdout while pushing works", async () => {
    // The regression this guards: a background task's stdout is delivered
    // in full when the process exits, so printing as well as pushing hands
    // every batch to the agent twice — and an orchestrator acting twice on
    // the same news is the failure that matters.
    const clock = virtualClock();
    const push = fakePeerPush();
    // The default 60s debounce, then a quiet phase the change feed idles
    // out at its 90s stall bound, puts 150s of virtual time between the
    // push and the fatal drain — well past the 30s receipt window.
    const { fetchImpl } = activityRoutes([
      ...batch([comment(9, 3, clock.iso())], "a1"),
      quiet,
      quiet,
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

    // Nothing but the position: by the time the watch died the batch had
    // sat out its receipt window and counted as landed.
    expect(result.stdout).toBe("cursor: a1\n");
    expect(result.exitCode).toBe(1);
    expect(push.pushes).toHaveLength(1);
    expect(push.pushes[0]?.since).toBe("a0");
    expect(push.pushes[0]?.cursor).toBe("a1");
    expect(push.pushes[0]?.body).toContain("comment 9");
    // The header names the command, so a reader can re-run it by hand.
    expect(push.pushes[0]?.body).toContain(
      "todou watch -p todou — 1 new entry",
    );
    expect(push.closed()).toBe(true);
  });

  it("degrades on a refusal: hands over the batch, says why, exits 0", async () => {
    const clock = virtualClock();
    const push = fakePeerPush({
      rejectAfter: {
        send: 1,
        rejection: { status: "held", reason: "awaiting approval in the TUI" },
      },
    });
    const { fetchImpl, drains } = activityRoutes([
      ...batch([comment(9, 3, clock.iso())], "a1"),
      quiet,
      quiet,
    ]);

    const result = await runCli(
      [
        "watch",
        "-p",
        "todou",
        "--since",
        "a0",
        "--follow=claude-code-messaging",
        "--interval",
        "2",
        "--timeout",
        "300",
      ],
      { fetchImpl, env: udsEnv, clock, openPeerPush: push.open },
    );

    // The same verdict a one-shot delivery gives, so a caller cannot tell
    // that the push channel was ever involved.
    expect(result.exitCode).toBe(0);
    // The batch nobody received, plus where to resume — the whole of the
    // pre-flag behaviour, only with the accumulated entries.
    expect(result.stdout).toContain("comment 9");
    expect(result.stdout).toContain("since: a0");
    expect(result.stdout).toContain("cursor: a1");
    // Verbatim reason, and the setting to change: crossSessionInbound is
    // consulted ahead of the receiver's own-process rule, so it holds even
    // a background process the session itself started.
    expect(result.stderr).toContain("held");
    expect(result.stderr).toContain("awaiting approval in the TUI");
    expect(result.stderr).toContain("crossSessionInbound");
    // Stopped without waiting the quiet phase out and without reaching the
    // drain that would have turned fatal: the refusal landed while the loop
    // was idling, and the wait it races was cut short.
    expect(clock.elapsed()).toBe(60_000);
    // The batch page, its terminator, the debounce tail and one empty
    // round — and then nothing, though the script had a fatal reply left.
    expect(drains()).toBe(4);
    expect(push.closed()).toBe(true);
  });

  it("flushes what is still unconfirmed even on a fatal error", async () => {
    // Without this a crash takes both the entries nobody received and the
    // position they were read from: uds mode prints nothing as it goes and
    // no cursor is kept on disk, so there would be nothing to resume from.
    const clock = virtualClock();
    const push = fakePeerPush();
    // The fatal drain lands right after the push, inside its window.
    const { fetchImpl } = activityRoutes([
      ...batch([comment(9, 3, clock.iso())], "a1"),
      quiet,
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
    // Still inside its receipt window when the drain died, so it is handed
    // over — once, not once per delivery attempt.
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "since: a0",
      "cursor: a1",
    ]);
    expect(push.closed()).toBe(true);
  });

  it("falls back to one batch when the receipt socket cannot be opened", async () => {
    const clock = virtualClock();
    const push = fakePeerPush({
      failOpen: Object.assign(new Error("bind EADDRINUSE"), {
        code: "EADDRINUSE",
      }),
    });
    // A one-shot delivery, but the flag's 60s debounce still applies, so
    // the window has a tail drain of its own.
    const { fetchImpl } = activityRoutes([
      ...batch([comment(9, 3, clock.iso())], "a1"),
      quiet,
    ]);

    const result = await runCli(
      ["watch", "-p", "todou", "--since", "a0", "--follow=uds"],
      { fetchImpl, env: udsEnv, clock, openPeerPush: push.open },
    );

    // Not blind pushing: a watch that cannot confirm delivery claims none,
    // and what it does instead is exactly what it did before this flag —
    // one batch, no `since:` line, exit 0.
    expect(result.exitCode).toBe(0);
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "cursor: a1",
    ]);
    expect(result.stderr).toContain("bind EADDRINUSE");
    expect(push.pushes).toHaveLength(0);
  });
});

describe("watch --follow=uds sender name (T-254)", () => {
  const udsEnv = {
    ...loggedInEnv(),
    CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/4242.sock",
  };
  /** The cross-project route table: one fatal drain, nothing else needed. */
  const crossRoutes = () => {
    const sse: SseStub = sseStub();
    return fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", () => sse.reply()],
      ["GET", "/api/activity", () => FATAL],
    ]).fetchImpl;
  };
  // The name is settled when the channel opens, before any batch exists, so
  // every case here lets the first drain turn fatal rather than staging a
  // delivery it would not read anything more out of.
  const nameFrom = async (argv: string[], fetchImpl: typeof fetch) => {
    const push = fakePeerPush();
    const result = await runCli(["watch", ...argv, "--since", "a0"], {
      fetchImpl,
      env: udsEnv,
      clock: virtualClock(),
      openPeerPush: push.open,
    });
    expect(result.exitCode).toBe(1);
    return push.fromName;
  };

  it("names one watched project", async () => {
    expect(
      await nameFrom(
        ["-p", "todou", "--follow=uds"],
        activityRoutes([]).fetchImpl,
      ),
    ).toBe("todou-watch-todou");
  });

  it("names a multi-project watch set in full", async () => {
    // Not truncated: a slug is lowercase alphanumerics and dashes, so a long
    // watch set only makes a long name, never an invalid envelope.
    expect(await nameFrom(["-p", "aa,bb", "--follow=uds"], crossRoutes())).toBe(
      "todou-watch-aa-bb",
    );
  });

  it("names an --all-projects watch", async () => {
    expect(
      await nameFrom(["--all-projects", "--follow=uds"], crossRoutes()),
    ).toBe("todou-watch-all");
  });
});

describe("watch --follow argument handling (T-252)", () => {
  it("refuses uds with no socket in the environment, before any request", async () => {
    const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["watch", "-p", "todou", "--follow=uds"], {
      fetchImpl,
      env: loggedInEnv(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CLAUDE_CODE_MESSAGING_SOCKET is not set");
    expect(result.stderr).toContain("--follow=stdout");
    // Nothing was read, so there is no half-started watch to reason about.
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown transport, --poll and --print-cursor", async () => {
    const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
    const run = (argv: string[]) =>
      runCli(["watch", "-p", "todou", ...argv], {
        fetchImpl,
        env: loggedInEnv(),
      });

    expect((await run(["--follow=webhook"])).stderr).toContain(
      'unknown --follow transport "webhook"',
    );
    expect((await run(["--follow", "--poll"])).stderr).toContain(
      "--follow conflicts with --poll",
    );
    expect((await run(["--follow", "--print-cursor"])).stderr).toContain(
      "--follow conflicts with --print-cursor",
    );
    expect(calls).toHaveLength(0);
  });

  it("leaves a one-shot batch spelled exactly as before", async () => {
    // The `since:` line belongs to standing mode alone: a one-shot batch
    // has no predecessor to abut, and its published shape is one cursor
    // line.
    const clock = virtualClock();
    const { fetchImpl } = activityRoutes([
      ...batch([comment(9, 3, clock.iso())], "a1"),
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--since", "a0", "--timeout", "300"],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("since:");
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "cursor: a1",
    ]);
  });
});
