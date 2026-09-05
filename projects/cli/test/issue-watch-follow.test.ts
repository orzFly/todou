import { describe, expect, it } from "vitest";
import { fakePeerPush } from "./fake-peer-push.ts";
import {
  fakeFetch,
  loggedInEnv,
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
const comment = (id: number, createdAt: string) => ({
  type: "comment",
  id,
  author,
  body: `comment ${id}`,
  created_at: createdAt,
  edited_at: null,
});
const page = (items: unknown[], cursor: string | null) => ({
  items,
  prev_cursor: null,
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

const udsEnv = {
  ...loggedInEnv("todou"),
  CLAUDE_CODE_MESSAGING_SOCKET: "/run/cc-socks/4242.sock",
};

/**
 * The route table every command-level case here drains through: one reply
 * per timeline request, in order, and a fatal 404 once the script runs out —
 * which is how a standing watch is stopped when nothing refuses it.
 *
 * Written out request by request, terminator pages included: a non-empty
 * page carrying a next_cursor makes `drainPaged` ask once more, so a batch
 * always costs two requests and a script keyed on the cursor alone would
 * quietly answer the wrong one.
 */
function timelineRoutes(replies: unknown[], extra: [string, unknown][] = []) {
  let next = 0;
  const sse: SseStub = sseStub();
  const { fetchImpl, calls } = fakeFetch([
    ["GET", "/api/me", me],
    ["GET", "/api/events", () => sse.reply()],
    ...extra.map(
      ([path, reply]) => ["GET", path, reply] as [string, string, unknown],
    ),
    [
      "GET",
      "/api/projects/todou/issues/3/timeline",
      () => replies[next++] ?? FATAL,
    ],
  ]);
  const drains = () => calls.filter((c) => c.url.includes("/timeline")).length;
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

describe("issue watch --follow=stdout (T-254)", () => {
  it("delivers every batch instead of exiting with the first", async () => {
    const clock = virtualClock();
    const { sse, fetchImpl } = timelineRoutes([
      ...batch([comment(9, clock.iso())], "c1"),
      quiet,
      ...batch([comment(10, clock.iso())], "c2"),
      // Past here the script runs out and the drain turns fatal, which is
      // the only off switch a standing watch nothing refuses has.
    ]);
    // Already latched when the first quiet phase starts, so the second
    // batch is drained because the feed asked for it rather than because
    // --interval elapsed — which is what `clock.elapsed()` below proves.
    sse.push("change", change);

    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
        "--follow",
        "--debounce",
        "0",
        "--interval",
        "2",
        "--timeout",
        "300",
      ],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );

    expect(result.exitCode).toBe(1);
    // Two whole batches, each closing with the range it covers — and each
    // batch's `since` is the previous batch's `cursor`.
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "since: c0",
      "cursor: c1",
      expect.stringContaining("comment 10"),
      "since: c1",
      "cursor: c2",
    ]);
    expect(clock.elapsed()).toBe(0);
  });
});

describe("issue watch --follow=uds (T-254)", () => {
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
    const { fetchImpl } = timelineRoutes([
      ...batch([comment(9, clock.iso())], "c1"),
      quiet,
      quiet,
    ]);

    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
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

    // Nothing but the position: by the time the watch died the batch had
    // sat out its receipt window and counted as landed. The arithmetic is
    // asserted rather than assumed — a script that put the fatal drain
    // inside the 30s window would print the batch and pass for the wrong
    // reason, which is exactly what this case exists to catch.
    expect(clock.elapsed()).toBe(150_000);
    expect(result.stdout).toBe("cursor: c1\n");
    expect(result.exitCode).toBe(1);
    expect(push.pushes).toHaveLength(1);
    expect(push.pushes[0]?.since).toBe("c0");
    expect(push.pushes[0]?.cursor).toBe("c1");
    expect(push.pushes[0]?.body).toContain("comment 9");
    // The header names the command, so a reader can re-run it by hand. With
    // no ref prefix to spell the card with, that is `<slug>/<number>` —
    // never an ambiguous `#N`, which names no project.
    expect(push.pushes[0]?.body).toContain(
      "todou issue watch todou/3 — 1 new entry",
    );
    // Which watch this is: a project watch on the same session would sign
    // itself `todou-watch-todou`, and both land in the same TUI.
    expect(push.fromName).toBe("todou-watch-todou-3");
    expect(push.closed()).toBe(true);
  });

  it("labels the push with the project's own ref spelling", async () => {
    const clock = virtualClock();
    const push = fakePeerPush();
    const { fetchImpl } = timelineRoutes(
      [...batch([comment(9, clock.iso())], "c1"), quiet, quiet],
      [
        [
          "/api/projects/todou/references/config",
          { format: { prefix: "T", history: [] }, autolinks: [] },
        ],
      ],
    );

    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
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
    expect(push.pushes[0]?.body).toContain("todou issue watch T-3 — 1 new");
    // The display name is an identifier and stays on the number: it does
    // not follow the ref spelling the label uses.
    expect(push.fromName).toBe("todou-watch-todou-3");
  });

  it("degrades on a refusal: hands over the batch, says why, exits 0", async () => {
    const clock = virtualClock();
    const push = fakePeerPush({
      rejectAfter: {
        send: 1,
        rejection: { status: "held", reason: "awaiting approval in the TUI" },
      },
    });
    const { fetchImpl, drains } = timelineRoutes([
      ...batch([comment(9, clock.iso())], "c1"),
      quiet,
      quiet,
    ]);

    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
        "--since",
        "c0",
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
    expect(result.stdout).toContain("since: c0");
    expect(result.stdout).toContain("cursor: c1");
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
    const { fetchImpl } = timelineRoutes([
      ...batch([comment(9, clock.iso())], "c1"),
      quiet,
    ]);

    const result = await runCli(
      [
        "issue",
        "watch",
        "3",
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
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "since: c0",
      "cursor: c1",
    ]);
    expect(push.closed()).toBe(true);
  });
});

describe("issue watch --follow argument handling (T-254)", () => {
  it("refuses uds with no socket before resolving the issue", async () => {
    // `issue watch` opens with a network round trip to resolve the ref, and
    // a --follow=uds with nothing to push to fails whichever card that is.
    const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
    const result = await runCli(["issue", "watch", "3", "--follow=uds"], {
      fetchImpl,
      env: loggedInEnv("todou"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("CLAUDE_CODE_MESSAGING_SOCKET is not set");
    expect(result.stderr).toContain("--follow=stdout");
    // Nothing was read, so there is no half-started watch to reason about.
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown transport and --poll", async () => {
    const { fetchImpl, calls } = fakeFetch([["GET", "/api/me", me]]);
    const run = (argv: string[]) =>
      runCli(["issue", "watch", "3", ...argv], {
        fetchImpl,
        env: loggedInEnv("todou"),
      });

    expect((await run(["--follow=webhook"])).stderr).toContain(
      'unknown --follow transport "webhook"',
    );
    expect((await run(["--follow", "--poll"])).stderr).toContain(
      "--follow conflicts with --poll",
    );
    expect(calls).toHaveLength(0);
  });

  it("leaves a one-shot batch spelled exactly as before", async () => {
    // The `since:` line belongs to standing mode alone: a one-shot batch
    // has no predecessor to abut, and its published shape is one cursor
    // line.
    const clock = virtualClock();
    const { fetchImpl } = timelineRoutes([
      ...batch([comment(9, clock.iso())], "c1"),
    ]);
    const result = await runCli(
      ["issue", "watch", "3", "--since", "c0", "--timeout", "300"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("since:");
    expect(bodyLines(result.stdout)).toEqual([
      expect.stringContaining("comment 9"),
      "cursor: c1",
    ]);
  });

  it("takes --debounce 0 and still refuses a negative window", async () => {
    // 0 is a real setting, not "off": it is the way back to immediate
    // delivery from the 60s window --follow defaults to.
    const clock = virtualClock();
    const { fetchImpl } = timelineRoutes([
      ...batch([comment(9, clock.iso())], "c1"),
    ]);
    const accepted = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--debounce", "0"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(accepted.exitCode).toBe(0);
    expect(accepted.stdout).toContain("comment 9");

    const negative = await runCli(
      ["issue", "watch", "3", "--poll", "--since", "c0", "--debounce=-1"],
      { fetchImpl, env: loggedInEnv("todou"), clock },
    );
    expect(negative.exitCode).toBe(1);
    expect(negative.stderr).toContain(
      "--debounce must be a non-negative number of seconds",
    );
  });
});
