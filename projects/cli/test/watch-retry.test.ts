import { TodouError } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { CliError, RetriesExhaustedError } from "../src/errors.ts";
import {
  isTransientError,
  type RetryOptions,
  retryTransient,
  runWatchLoop,
  watchMode,
  watchRetryOptions,
  watchTimeoutSec,
} from "../src/watch-loop.ts";
import {
  fakeFetch,
  loggedInEnv,
  parseNdjson,
  runCli,
  virtualClock,
} from "./harness.ts";

const fetchFailed = () =>
  new TypeError("fetch failed", {
    cause: new Error("connect ECONNREFUSED 127.0.0.1:80"),
  });

const http = (status: number, message?: string) =>
  new TodouError(status, "test", message ?? String(status));

/** Millisecond-scale budget so tests never sit in real backoff. */
const fastRetry = (over: Partial<RetryOptions> = {}): RetryOptions => ({
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  ...over,
});

describe("isTransientError", () => {
  it("classifies retryable vs fatal errors", () => {
    for (const status of [500, 502, 503, 504, 408, 429]) {
      expect(isTransientError(http(status))).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientError(http(status))).toBe(false);
    }
    expect(isTransientError(fetchFailed())).toBe(true);
    expect(isTransientError(new TypeError("terminated"))).toBe(true);
    expect(isTransientError(new Error("boom"))).toBe(false);
    expect(isTransientError(new SyntaxError("bad json"))).toBe(false);
  });
});

describe("watchRetryOptions", () => {
  /** Total sleep at the jitter floor (each delay is drawn from [cap/2, cap)). */
  const guaranteedRideOutMs = (opts: RetryOptions): number => {
    let total = 0;
    for (let failures = 1; failures < opts.maxAttempts; failures++) {
      total +=
        Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (failures - 1)) / 2;
    }
    return total;
  };

  it("blocking budget outlasts a slow deploy restart, poll stays snappy", () => {
    // A dogfood restart is a measured ~92s outage (SIGTERM ignored, systemd
    // kills at 90s); the sentinel must never give up inside that window.
    expect(
      guaranteedRideOutMs(watchRetryOptions({ poll: false })),
    ).toBeGreaterThan(120_000);
    expect(guaranteedRideOutMs(watchRetryOptions({ poll: true }))).toBeLessThan(
      3_000,
    );
  });

  it("--forever lifts the ceiling and keeps the blocking backoff", () => {
    const forever = watchRetryOptions({ poll: false, forever: true });
    expect(forever.maxAttempts).toBe(Number.POSITIVE_INFINITY);
    expect(forever.baseDelayMs).toBe(1000);
    expect(forever.maxDelayMs).toBe(30_000);
  });
});

describe("watchMode / watchTimeoutSec", () => {
  it("refuses --forever together with --poll", () => {
    const error: unknown = (() => {
      try {
        return watchMode(true, true);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe("--forever conflicts with --poll");
  });

  it("defaults the quiet window to 60s, or 600s as a heartbeat", () => {
    expect(watchTimeoutSec(undefined, { poll: false })).toBe(60);
    expect(watchTimeoutSec(undefined, { poll: true })).toBe(60);
    expect(watchTimeoutSec(undefined, { poll: false, forever: true })).toBe(
      600,
    );
    // An explicit --timeout is honoured in either mode.
    expect(watchTimeoutSec("45", { poll: false, forever: true })).toBe(45);
  });
});

describe("retryTransient", () => {
  it("retries transient failures until success and reports progress", async () => {
    let calls = 0;
    const notes: string[] = [];
    const result = await retryTransient(
      async () => {
        calls += 1;
        if (calls < 3) throw http(502, "upstream reset");
        return "ok";
      },
      fastRetry({ onRetry: (line) => notes.push(line) }),
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("transient failure 1/3");
    expect(notes[0]).toContain("HTTP 502 — upstream reset");
    expect(notes[1]).toContain("transient failure 2/3");
  });

  it("gives up after maxAttempts consecutive failures with exit code 4", async () => {
    let calls = 0;
    const error: unknown = await retryTransient(async () => {
      calls += 1;
      throw fetchFailed();
    }, fastRetry()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect((error as RetriesExhaustedError).exitCode).toBe(4);
    expect((error as Error).message).toContain(
      "giving up after 3 consecutive network failures",
    );
    expect((error as Error).message).toContain("ECONNREFUSED");
    expect(calls).toBe(3);
  });

  it("keeps going on an infinite budget, and drops the denominator", async () => {
    let calls = 0;
    const notes: string[] = [];
    const result = await retryTransient(
      async () => {
        calls += 1;
        if (calls < 21) throw http(502);
        return "ok";
      },
      fastRetry({
        maxAttempts: Number.POSITIVE_INFINITY,
        onRetry: (line) => notes.push(line),
      }),
    );
    // Twenty consecutive failures — past the 14 a blocking watch tolerates,
    // and seven times --poll's — still deliver: exit 4 is out of reach.
    expect(result).toBe("ok");
    expect(calls).toBe(21);
    expect(notes).toHaveLength(20);
    expect(notes[14]).toContain("transient failure 15 (");
    // No "n/Infinity", and no denominator of any other shape either.
    expect(notes[14]).not.toContain("/");
  });

  it("lets fatal errors through immediately, without retrying", async () => {
    for (const fatal of [http(404, "no such issue"), new Error("boom")]) {
      let calls = 0;
      const error: unknown = await retryTransient(async () => {
        calls += 1;
        throw fatal;
      }, fastRetry()).catch((e: unknown) => e);
      expect(error).toBe(fatal);
      expect(calls).toBe(1);
    }
  });

  it("backs off exponentially with a capped, jittered delay", async () => {
    const run = async (random: () => number): Promise<number[]> => {
      const delays: number[] = [];
      let calls = 0;
      await retryTransient(
        async () => {
          calls += 1;
          if (calls < 8) throw http(503);
          return "ok";
        },
        {
          maxAttempts: 8,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          sleep: async (ms) => {
            delays.push(ms);
          },
          random,
        },
      );
      return delays;
    };

    // The jitter window is [cap/2, cap): random()=0 pins the floor …
    expect(await run(() => 0)).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 15_000,
    ]);
    // … and any other draw stays inside the window of the doubling cap.
    const caps = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    const jittered = await run(Math.random);
    expect(jittered).toHaveLength(caps.length);
    for (const [i, delay] of jittered.entries()) {
      expect(delay).toBeGreaterThanOrEqual(caps[i] / 2);
      expect(delay).toBeLessThan(caps[i]);
    }
  });
});

describe("runWatchLoop retry integration", () => {
  const page = (items: Array<{ created_at: string }>, cursor?: string) => ({
    items,
    cursor,
  });
  const entry = { created_at: "2026-08-11T12:00:00Z" };

  it("resets the consecutive-failure count after every successful drain", async () => {
    // Four transient failures in total — over the budget of three — but
    // never three in a row, so the loop must ride them all out.
    const script = [
      () => Promise.reject(http(502)),
      () => Promise.reject(fetchFailed()),
      () => Promise.resolve(page([], "c1")),
      () => Promise.reject(http(503)),
      () => Promise.reject(http(504)),
      () => Promise.resolve(page([entry], "c2")),
    ];
    let drained = 0;
    let delivered: unknown[] = [];
    let deliveredCursor: string | undefined;
    const code = await runWatchLoop({
      poll: false,
      timeoutSec: 5,
      intervalSec: 0.001,
      baseline: "c0",
      retry: fastRetry(),
      drain: () => script[drained++](),
      onItems: (items, cursor) => {
        delivered = items;
        deliveredCursor = cursor;
      },
      onEmpty: () => {
        throw new Error("should have delivered items");
      },
    });
    expect(code).toBe(0);
    expect(drained).toBe(6);
    expect(delivered).toEqual([entry]);
    expect(deliveredCursor).toBe("c2");
  });

  it("gives up when failures are consecutive, keeping the drain count exact", async () => {
    let drained = 0;
    const error: unknown = await runWatchLoop({
      poll: false,
      timeoutSec: 5,
      intervalSec: 0.001,
      baseline: undefined,
      retry: fastRetry(),
      drain: () => {
        drained += 1;
        return Promise.reject(http(502));
      },
      onItems: () => {},
      onEmpty: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect(drained).toBe(3);
  });

  it("aborts on the first fatal error", async () => {
    let drained = 0;
    const fatal = http(404, "gone");
    const error: unknown = await runWatchLoop({
      poll: false,
      timeoutSec: 5,
      intervalSec: 0.001,
      baseline: undefined,
      retry: fastRetry(),
      drain: () => {
        drained += 1;
        return Promise.reject(fatal);
      },
      onItems: () => {},
      onEmpty: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBe(fatal);
    expect(drained).toBe(1);
  });

  it("a --poll that finds nothing still exits 0", async () => {
    let reported: string | undefined | "unset" = "unset";
    const code = await runWatchLoop({
      poll: true,
      timeoutSec: 5,
      intervalSec: 0.001,
      baseline: "c0",
      retry: fastRetry(),
      drain: () => Promise.resolve(page([])),
      onItems: () => {
        throw new Error("nothing was there to deliver");
      },
      onEmpty: (cursor) => {
        reported = cursor;
      },
    });
    // The check completed; whether it found anything is the output's job
    // to say, which is what frees callers of `; true` after a bootstrap.
    expect(code).toBe(0);
    expect(reported).toBe("c0");
  });

  it("--forever rides out an outage and a quiet spell on its held cursor", async () => {
    const clock = virtualClock();
    const seen: Array<string | undefined> = [];
    const quiet: number[] = [];
    const notes: string[] = [];
    let drains = 0;
    let delivered: unknown[] = [];
    let deliveredCursor: string | undefined;
    const code = await runWatchLoop({
      poll: false,
      forever: true,
      timeoutSec: 10,
      intervalSec: 5,
      baseline: "c0",
      retry: fastRetry({
        maxAttempts: Number.POSITIVE_INFINITY,
        onRetry: (line) => notes.push(line),
      }),
      clock,
      drain: (after) => {
        seen.push(after);
        drains += 1;
        if (drains <= 6) return Promise.reject(http(502));
        // Two full quiet phases of nothing, then the entry that landed
        // while the watcher was blind.
        if (drains <= 12) return Promise.resolve(page([]));
        return Promise.resolve(page([entry], "c1"));
      },
      onItems: (items, cursor) => {
        delivered = items;
        deliveredCursor = cursor;
      },
      onEmpty: () => {
        throw new Error("--forever must never report an empty verdict");
      },
      onQuiet: (_cursor, totalMs) => quiet.push(totalMs),
    });

    expect(code).toBe(0);
    // Six consecutive failures, twice the budget this retry was handed a
    // finite version of, and it never gave up.
    expect(notes).toHaveLength(6);
    expect(notes[5]).toContain("transient failure 6 (");
    // The gap entry is delivered, and every drain along the way asked from
    // the cursor the loop already held — the one thing that would have
    // skipped it is re-reading "now" after the outage.
    expect(delivered).toEqual([entry]);
    expect(deliveredCursor).toBe("c1");
    expect(new Set(seen)).toEqual(new Set(["c0"]));
    expect(quiet).toEqual([10_000, 20_000]);
    expect(clock.elapsed()).toBe(20_000);
  });

  it("--forever still aborts on the first fatal error", async () => {
    let drained = 0;
    const fatal = http(404, "gone");
    const error: unknown = await runWatchLoop({
      poll: false,
      forever: true,
      timeoutSec: 5,
      intervalSec: 0.001,
      baseline: undefined,
      retry: fastRetry({ maxAttempts: Number.POSITIVE_INFINITY }),
      drain: () => {
        drained += 1;
        return Promise.reject(fatal);
      },
      onItems: () => {},
      onEmpty: () => {},
    }).catch((e: unknown) => e);
    expect(error).toBe(fatal);
    expect(drained).toBe(1);
  });
});

describe("watch command network robustness", () => {
  const me = {
    id: 2,
    login: "claude",
    display_name: "Claude",
    kind: "machine",
    owner: null,
  };
  const comment = {
    type: "comment",
    id: 9,
    author: {
      id: 5,
      login: "user",
      display_name: "User",
      kind: "human",
      owner: null,
    },
    body: "made it through",
    created_at: "2026-08-11T12:00:00Z",
    edited_at: null,
    issue_number: 3,
  };

  it("rides out 5xx blips on startup and mid-drain (real deploy-restart shape)", async () => {
    const clock = virtualClock();
    let meCalls = 0;
    let activityCalls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", () => (++meCalls === 1 ? { __status: 502 } : me)],
      [
        "GET",
        "/api/projects/todou/activity",
        (_init: RequestInit, url: URL) => {
          activityCalls += 1;
          if (activityCalls === 1) return { __status: 502 };
          return url.searchParams.get("after") === "a0"
            ? { items: [comment], next_cursor: "a1" }
            : { items: [], next_cursor: null };
        },
      ],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0", "--json"],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(0);
    expect(meCalls).toBe(2);
    expect(activityCalls).toBe(3);
    // Every line parses on its own: parseNdjson throws otherwise, which is
    // the assertion that retry chatter never lands mid-stream. Merging the
    // two streams with `2>&1` is what forced consumers into defensive
    // incremental JSON scraping before T-175.
    const { items, cursor } = parseNdjson<{ issue_number: number }>(
      result.stdout,
    );
    expect(items[0]?.issue_number).toBe(3);
    expect(cursor.next_cursor).toBe("a1");
    expect(result.stderr).toContain("transient failure 1/3 (HTTP 502)");
    expect(result.stdout).not.toContain("transient failure");
  });

  it("--forever outlasts the blocking budget and says so on stderr only", async () => {
    const clock = virtualClock();
    let activityCalls = 0;
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/events", { __status: 404 }],
      [
        "GET",
        "/api/projects/todou/activity",
        () => {
          activityCalls += 1;
          // Twenty consecutive 502s: past the 14 a blocking watch rides out
          // and far past --poll's 3, so getting through them at all is the
          // proof that --forever picked the unbounded budget.
          if (activityCalls <= 20) return { __status: 502 };
          return activityCalls < 25
            ? { items: [], next_cursor: null }
            : { items: [comment], next_cursor: "a1" };
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
        "--forever",
        "--timeout",
        "10",
        "--interval",
        "5",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("transient failure 20 (HTTP 502)");
    expect(result.stderr).toContain("still watching — nothing new in 10s");
    // stdout stays the data stream T-175 made it: every line parses, and
    // neither kind of progress line leaked into it.
    const { items, cursor } = parseNdjson<{ issue_number: number }>(
      result.stdout,
    );
    expect(items[0]?.issue_number).toBe(3);
    expect(cursor.next_cursor).toBe("a1");
    expect(result.stdout).not.toContain("transient failure");
    expect(result.stdout).not.toContain("still watching");
  });

  it("refuses --forever together with --poll, in all three commands", async () => {
    for (const argv of [
      ["watch", "-p", "todou", "--forever", "--poll"],
      ["issue", "watch", "3", "-p", "todou", "--forever", "--poll"],
      ["question", "wait", "19", "42", "-p", "todou", "--forever", "--poll"],
    ]) {
      const { fetchImpl, calls } = fakeFetch([]);
      const result = await runCli(argv, { fetchImpl, env: loggedInEnv() });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--forever conflicts with --poll");
      // The contradiction is settled before anything is asked of the server.
      expect(calls).toHaveLength(0);
    }
  });

  it("question wait --forever heartbeats until the answer lands", async () => {
    const clock = virtualClock();
    const user = {
      id: 5,
      login: "user",
      display_name: "User",
      kind: "human",
      owner: null,
    };
    let polls = 0;
    const { fetchImpl } = fakeFetch([
      [
        "GET",
        "/api/projects/todou/issues/19/timeline",
        (_init: RequestInit, url: URL) => {
          if (url.searchParams.get("last") === "1") {
            return { items: [], prev_cursor: null, next_cursor: "C0" };
          }
          polls += 1;
          // Four quiet minutes at a 120s heartbeat: two beats, then the
          // answer — the shape of a question asked while nobody is looking.
          if (polls < 7) {
            return { items: [], prev_cursor: null, next_cursor: null };
          }
          return {
            items: [
              {
                type: "event",
                id: 7,
                event_type: "question_answered",
                actor: user,
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
                created_at: "2026-08-12T01:00:00Z",
                agent_context: null,
              },
            ],
            prev_cursor: null,
            next_cursor: null,
          };
        },
      ],
      [
        "GET",
        "/api/projects/todou/issues/19/questions",
        {
          items: [
            {
              comment_id: 42,
              author: user,
              created_at: "2026-08-12T00:00:00Z",
              questions: [
                {
                  key: "schema",
                  header: "Data model",
                  question: "Where does the payload live?",
                  multiple: false,
                  options: [{ label: "New entity" }, { label: "Inline" }],
                },
              ],
              answer: null,
            },
          ],
          open: 1,
        },
      ],
    ]);
    const result = await runCli(
      [
        "question",
        "wait",
        "19",
        "42",
        "-p",
        "todou",
        "--forever",
        "--timeout",
        "120",
        "--interval",
        "60",
        "--json",
      ],
      { fetchImpl, env: loggedInEnv(), clock },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).event_id).toBe(7);
    expect(result.stderr).toContain(
      "still waiting for an answer — nothing new in 120s (2m total)",
    );
    expect(result.stderr).toContain("(4m total)");
    expect(clock.elapsed()).toBe(240_000);
  });

  it("exits 4 with a clear message when the server stays down", async () => {
    const clock = virtualClock();
    const { fetchImpl } = fakeFetch([
      ["GET", "/api/me", me],
      ["GET", "/api/projects/todou/activity", { __status: 503 }],
    ]);
    const result = await runCli(
      ["watch", "-p", "todou", "--poll", "--since", "a0"],
      { fetchImpl, env: loggedInEnv(), clock },
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain(
      "giving up after 3 consecutive network failures",
    );
    expect(result.stderr).toContain("HTTP 503");
    expect(result.stderr).toContain("rerun with the same cursor");
  });
});
