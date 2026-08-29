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
 * Reply `{ __status: n, body }` to force a status, or a ready-made
 * `Response` for anything JSON cannot express (an event stream); unmatched
 * requests throw so tests never silently talk past the stub.
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
    if (raw instanceof Response) return raw;
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

export type SseStub = {
  /** Route reply: one live `text/event-stream` response per open. */
  reply: () => Response;
  /** Queues a frame; before the first open it waits for the subscriber. */
  push: (event: string, data: unknown) => void;
  /** Ends the current connection the way a dropped stream does. */
  drop: () => void;
  /** How many times the feed has been subscribed to. */
  opens: () => number;
};

/**
 * A stand-in for the server's change feed (T-122). Frames queued before
 * the first open are delivered with the opening `hello`, in the same chunk
 * the subscriber's first read returns — which is what lets a test say
 * "the feed had already spoken" without racing the watch's startup.
 */
export function sseStub(): SseStub {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pending = "event: hello\ndata: {}\n\n";
  let opens = 0;
  const write = (text: string) => {
    if (controller === null) pending += text;
    else controller.enqueue(encoder.encode(text));
  };
  return {
    reply: () => {
      opens += 1;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(encoder.encode(pending));
          pending = "event: hello\ndata: {}\n\n";
        },
        cancel() {
          controller = null;
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    push: (event, data) =>
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    drop: () => {
      controller?.close();
      controller = null;
    },
    opens: () => opens,
  };
}

export async function runCli(
  argv: string[],
  options: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
    cwd?: string;
    stdinText?: string;
    /** Marks the stub stdin as a terminal, for the prompt paths. */
    stdinIsTTY?: boolean;
    clock?: Clock;
    openBrowser?: (url: string) => void;
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

  const stdin = Readable.from([options.stdinText ?? ""]);
  if (options.stdinIsTTY) {
    (stdin as Readable & { isTTY?: boolean }).isTTY = true;
  }

  const exitCode = await cli.run(argv, {
    stdin,
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
    // Unset would spawn a real browser on whoever runs the suite.
    openBrowser: options.openBrowser ?? (() => {}),
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
 * advances `now` instead of waiting, so a watch loop's poll cadence,
 * timeout and debounce window are settled by arithmetic and never by how
 * loaded the machine is (T-127). That makes `elapsed()` an exact assertion
 * rather than a tolerance, and costs no wall time even for a 60s window.
 *
 * A sleep completes on a macrotask, and an aborted one advances nothing.
 * Both are what a real timer does, and both matter to anything that races
 * a sleep against an event (T-123): resolving synchronously would hand the
 * race to the timer every time, hiding whether the event ever wins, and
 * charging virtual seconds for a wait that was cut short would make
 * `elapsed()` lie about it.
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
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          now += ms;
          resolve();
        }, 0);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    elapsed: () => now - startMs,
    iso: (offsetMs = 0) => new Date(now + offsetMs).toISOString(),
  };
}

export type CursorLine = {
  type: "cursor";
  next_cursor: string | null;
  ref_format?: { prefix: string | null; token: string };
};

/**
 * A watch's NDJSON stdout taken apart the way a consumer has to: every
 * line parsed on its own — that being the whole point of the format, so a
 * line that is not JSON fails here and names itself — and the batch's last
 * record read as its cursor.
 */
export function parseNdjson<T = Record<string, unknown>>(
  stdout: string,
): { items: T[]; cursor: CursorLine; lines: number } {
  const lines = stdout.split("\n").filter((line) => line !== "");
  const records = lines.map((line, i) => {
    try {
      return JSON.parse(line) as { type: string };
    } catch {
      throw new Error(`stdout line ${i + 1} is not JSON: ${line}`);
    }
  });
  const last = records.at(-1);
  if (last?.type !== "cursor") {
    throw new Error(`batch does not end with a cursor record:\n${stdout}`);
  }
  return {
    items: records.slice(0, -1) as T[],
    cursor: last as CursorLine,
    lines: lines.length,
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
