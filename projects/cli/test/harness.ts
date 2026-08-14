import { PassThrough, Readable } from "node:stream";
import { Builtins, Cli } from "clipanion";
import type { CliContext } from "../src/api-command.ts";
import type { Clock } from "../src/clock.ts";
import { commands } from "../src/commands/index.ts";

export type Captured = { url: string; init: RequestInit };

export type Route = [
  method: string,
  path: string,
  reply: unknown | ((init: RequestInit, url: URL) => unknown),
];

/**
 * Route-table fetch stub: matches on method + pathname, replies 200 JSON.
 * Reply `{ __status: n, body }` to force a status; unmatched requests throw
 * so tests never silently talk past the stub.
 */
export function fakeFetch(routes: Route[]) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://stub.test");
    calls.push({ url: String(input), init: init ?? {} });
    const method = init?.method ?? "GET";
    const route = routes.find(
      ([m, p]) =>
        m.toUpperCase() === method.toUpperCase() && p === url.pathname,
    );
    if (!route) {
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    }
    const raw =
      typeof route[2] === "function"
        ? (route[2] as (init: RequestInit, url: URL) => unknown)(
            init ?? {},
            url,
          )
        : route[2];
    const forced = raw as { __status?: number; body?: unknown };
    const status = forced?.__status ?? 200;
    const body = forced?.__status !== undefined ? forced.body : raw;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export async function runCli(
  argv: string[],
  options: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
    cwd?: string;
    stdinText?: string;
    clock?: Clock;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cli = new Cli<CliContext>({
    binaryLabel: "todou",
    binaryName: "todou",
    binaryVersion: "0.0.0-test",
  });
  for (const command of commands) {
    cli.register(command);
  }
  cli.register(Builtins.HelpCommand);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));

  const exitCode = await cli.run(argv, {
    stdin: Readable.from([options.stdinText ?? ""]),
    stdout,
    stderr,
    colorDepth: 1,
    // Real user config/state must never leak into tests, so XDG always
    // points somewhere that does not exist unless the test overrides it.
    env: {
      XDG_CONFIG_HOME: "/nonexistent-todou-xdg",
      XDG_STATE_HOME: "/nonexistent-todou-xdg",
      ...options.env,
    },
    cwd: options.cwd ?? "/",
    fetchImpl: options.fetchImpl,
    clock: options.clock,
  });

  return {
    exitCode,
    stdout: Buffer.concat(outChunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  };
}

export type VirtualClock = Clock & {
  /** Virtual milliseconds waited since the clock was created. */
  elapsed: () => number;
  /** ISO timestamp `offsetMs` from the current virtual instant. */
  iso: (offsetMs?: number) => string;
};

/**
 * A clock that moves only when the code under test asks to wait: `sleep`
 * advances `now` and resolves at once, so a watch loop's poll cadence,
 * timeout and debounce window are settled by arithmetic and never by how
 * loaded the machine is (T-127). That makes `elapsed()` an exact assertion
 * rather than a tolerance, and costs no wall time even for a 60s window.
 *
 * Feed fixture timestamps from `iso()`, not `new Date()`: the debounce
 * anchor compares `created_at` against this clock, so an entry is "live"
 * only if both readings come from the same clock.
 */
export function virtualClock(start = "2026-08-11T12:00:00.000Z"): VirtualClock {
  const startMs = Date.parse(start);
  let now = startMs;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    elapsed: () => now - startMs,
    iso: (offsetMs = 0) => new Date(now + offsetMs).toISOString(),
  };
}

/** Context vars for a logged-in session without touching the filesystem. */
export function loggedInEnv(project?: string): Record<string, string> {
  return {
    TODOU_SERVER: "http://stub.test",
    TODOU_TOKEN: "todou_pat_test",
    ...(project ? { TODOU_PROJECT: project } : {}),
  };
}
