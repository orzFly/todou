import type { AgentContext, TodouClient } from "@todou/shared";
import { TimelineFilterType, TodouError } from "@todou/shared";
import { type Clock, systemClock } from "./clock.ts";
import { CliError, RetriesExhaustedError } from "./errors.ts";

/** Validates a comma-separated --type list, returning it normalized. */
export function normalizeTypes(raw: string): string {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) {
    throw new CliError("--type must name at least one type");
  }
  for (const part of parts) {
    if (!TimelineFilterType.safeParse(part).success) {
      throw new CliError(
        `unknown --type "${part}"`,
        `valid types: ${TimelineFilterType.options.join(", ")}`,
      );
    }
  }
  return parts.join(",");
}

/**
 * Errors worth retrying: the request may succeed verbatim a moment later.
 * 5xx/408/429 are server-side or throttling hiccups; undici surfaces every
 * connection-level failure (refused, DNS, reset, mid-body termination) as a
 * TypeError. Everything else — 4xx, parse errors, bugs — is fatal.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof TodouError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return error instanceof TypeError;
}

function describeError(error: unknown): string {
  if (error instanceof TodouError) {
    return error.message === String(error.status)
      ? `HTTP ${error.status}`
      : `HTTP ${error.status} — ${error.message}`;
  }
  if (error instanceof TypeError) {
    return (error.cause as Error | undefined)?.message ?? error.message;
  }
  return String(error);
}

export type RetryOptions = {
  /** Consecutive transient failures tolerated before giving up. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Progress line per retry, for stderr. */
  onRetry?: (line: string) => void;
  /** Backoff waits; unset means the system clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam. */
  random?: () => number;
};

/**
 * The retry budgets behind watch/poll commands. A blocking watch is a
 * sentinel: it must ride out a full deploy restart, and on dogfood the
 * server today ignores SIGTERM, so systemd's 90s stop timeout makes every
 * restart a ~92s outage. 14 attempts guarantee ≥135s of retrying even at
 * the jitter floor (~200s typical) before giving up with exit code 4.
 * `--poll` callers expect promptness, so a blip gets two quick retries and
 * a real outage fails fast.
 */
export function watchRetryOptions(
  poll: boolean,
  onRetry?: (line: string) => void,
  clock: Clock = systemClock,
): RetryOptions {
  const budget = poll
    ? { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 1000 }
    : { maxAttempts: 14, baseDelayMs: 1000, maxDelayMs: 30_000 };
  return { ...budget, onRetry, sleep: clock.sleep };
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff and
 * jitter (delay drawn from [cap/2, cap), cap doubling up to maxDelayMs).
 * Non-transient errors pass through untouched; the `maxAttempts`th
 * consecutive failure throws RetriesExhaustedError (exit code 4).
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const wait = opts.sleep ?? systemClock.sleep;
  const random = opts.random ?? Math.random;
  let failures = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientError(error)) throw error;
      failures += 1;
      if (failures >= opts.maxAttempts) {
        throw new RetriesExhaustedError(
          `giving up after ${failures} consecutive network failures — last: ${describeError(error)}`,
          "rerun with the same cursor to resume without losing entries (exit code 4 = transient outage, not a usage error)",
        );
      }
      const cap = Math.min(
        opts.maxDelayMs,
        opts.baseDelayMs * 2 ** (failures - 1),
      );
      const delayMs = cap / 2 + random() * (cap / 2);
      opts.onRetry?.(
        `transient failure ${failures}/${opts.maxAttempts} (${describeError(error)}); retrying in ${(delayMs / 1000).toFixed(1)}s`,
      );
      await wait(delayMs);
    }
  }
}

/** Query parameters that spell "not mine" for the watch endpoints. */
export type SelfFilter = {
  excludeActor?: number;
  excludeAgentSession?: string;
};

/**
 * The default self-filter of every watch: this agent session's own writes,
 * falling back to this account for entries no session claims (T-121). Both
 * axes travel together — see the `exclude_agent_session` schema for how the
 * server composes them.
 */
export async function resolveSelfFilter(
  client: TodouClient,
  agentContext: AgentContext | null,
  retry: RetryOptions,
): Promise<SelfFilter> {
  return {
    excludeActor: (await retryTransient(() => client.me(), retry)).id,
    // `||`, not `??`: a harness may report an empty session id, which names
    // nothing to filter on — and the server rejects it as a query param.
    excludeAgentSession: agentContext?.session_id || undefined,
  };
}

/**
 * The shared poll-until-news loop behind `issue watch` and `watch`.
 * Returns the process exit code: 0 when entries were delivered, 3 when the
 * poll came back empty or the timeout elapsed (loop-friendly "no news").
 *
 * `timeoutSec` bounds the quiet phase only; once the first entries arrive,
 * `debounceSec` (when set) takes over and keeps batching until the window
 * closes, so the process may outlive the timeout by up to the debounce
 * duration. The window is measured from when the newest entry of the first
 * batch *happened* (`created_at`), not from when this watcher saw it, so a
 * resume that back-fills old history returns immediately.
 */
export async function runWatchLoop<T extends { created_at: string }>(opts: {
  poll: boolean;
  timeoutSec: number;
  intervalSec: number;
  /** Batch window after the first batch's newest `created_at`; undefined = emit immediately. */
  debounceSec?: number;
  baseline: string | undefined;
  drain: (
    after: string | undefined,
  ) => Promise<{ items: T[]; cursor: string | undefined }>;
  onItems: (items: T[], cursor: string | undefined) => void;
  onEmpty: (cursor: string | undefined) => void;
  /** Overrides the poll-derived transient-failure budget. */
  retry?: RetryOptions;
  /**
   * Every deadline below is read from here, so a test can hand in a virtual
   * clock and settle the timeout and debounce windows by arithmetic (T-127).
   */
  clock?: Clock;
}): Promise<number> {
  let cursor = opts.baseline;
  const clock = opts.clock ?? systemClock;
  const deadline = clock.now() + opts.timeoutSec * 1000;
  const retry = opts.retry ?? watchRetryOptions(opts.poll, undefined, clock);

  // Cursors are absolute stream positions and only advance once a drain
  // has returned, so re-draining with the held cursor after a failure
  // loses nothing and repeats nothing. That makes retryTransient safe at
  // this one seam, which both the quiet-phase and the debounce loops drain
  // through; a success resets the consecutive-failure count. Retry sleeps
  // may overrun the quiet-phase deadline or the debounce window — that only
  // delays the verdict, and beats a false "no news" exit while unreachable.
  const drainOnce = async (): Promise<T[]> => {
    const page = await retryTransient(() => opts.drain(cursor), retry);
    cursor = page.cursor ?? cursor;
    return page.items;
  };

  for (;;) {
    const items = await drainOnce();
    if (items.length > 0) {
      if (opts.debounceSec !== undefined && !opts.poll) {
        // The window is anchored on when the newest entry of this first
        // batch happened, not on when the watcher saw it (T-50): resuming
        // with an old cursor over already-quiet history returns at once
        // instead of idling out a full window, while live entries
        // (created_at ≈ now) still get the whole window. The anchor is
        // clamped to now — server clock skew or an unparsable timestamp
        // (NaN → 0) must never stretch the wait — and never moves once
        // set, so sustained activity cannot defer the return forever.
        // Entries landing after the window closes stay beyond `cursor`
        // for the caller's next watch.
        const newest = Math.max(
          ...items.map((item) => Date.parse(item.created_at) || 0),
        );
        const windowEnd =
          Math.min(clock.now(), newest) + opts.debounceSec * 1000;
        for (;;) {
          const remaining = windowEnd - clock.now();
          if (remaining <= 0) break;
          await clock.sleep(Math.min(opts.intervalSec * 1000, remaining));
          items.push(...(await drainOnce()));
        }
      }
      opts.onItems(items, cursor);
      return 0;
    }
    const remaining = deadline - clock.now();
    if (opts.poll || remaining <= 0) {
      opts.onEmpty(cursor);
      return 3;
    }
    await clock.sleep(Math.min(opts.intervalSec * 1000, remaining));
  }
}
