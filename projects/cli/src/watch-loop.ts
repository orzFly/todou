import type { AgentContext, TodouClient } from "@todou/shared";
import { TimelineFilterType, TodouError } from "@todou/shared";
import { type Clock, systemClock } from "./clock.ts";
import { CliError, RetriesExhaustedError } from "./errors.ts";
import { formatDuration } from "./format.ts";
import { parseSeconds } from "./parse.ts";

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

export function describeError(error: unknown): string {
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

/** Which waiting mode a command is in; picks the retry budget below. */
export type WatchMode = { poll: boolean; forever?: boolean };

/**
 * The mode the flags asked for. `--poll` wants one check and out,
 * `--forever` wants never to come back empty-handed: asking for both is a
 * contradiction rather than a question of precedence.
 */
export function watchMode(poll: boolean, forever: boolean): WatchMode {
  if (poll && forever) {
    throw new CliError(
      "--forever conflicts with --poll",
      "--poll checks once and leaves; --forever blocks until entries arrive or a fatal error",
    );
  }
  return { poll, forever };
}

/**
 * The two contradictions `--print-cursor` can be in, worded once so both
 * watches refuse them identically.
 */
export function checkPrintCursor(
  printCursor: boolean,
  opts: { poll: boolean; json: boolean },
): void {
  if (!printCursor) return;
  if (!opts.poll) {
    throw new CliError(
      "--print-cursor only makes sense with --poll",
      "a blocking watch prints its own `cursor:` line when it returns",
    );
  }
  if (opts.json) {
    throw new CliError(
      "--print-cursor and --json both want stdout",
      "drop one — --json already ends its batch with a cursor record",
    );
  }
}

/**
 * The bare cursor `--print-cursor` writes, or the refusal to write an empty
 * one: stdout carries the cursor and nothing else, so the whole output is
 * what a command substitution wants, and something with no activity yet
 * mints no cursor. An empty capture silently meaning "start at now" on the
 * next call is the confusion this flag exists to end — so say so instead.
 * `subject` names what has been quiet ("in the watch set", "on this issue").
 */
export function printableCursor(
  cursor: string | undefined,
  subject: string,
): string {
  if (cursor === undefined) {
    throw new CliError(
      `no cursor to print: nothing has happened ${subject} yet`,
      "the first comment or event mints one; until then omit --since, which already means now",
    );
  }
  return cursor;
}

/**
 * How much quiet the watch tolerates: the timeout a blocking watch exits 3
 * at, or under `--forever` the gap between heartbeats. That is why the
 * default splits — 60s is a fair bound to give up at, and far too shrill a
 * pulse for the twelve-hour waits `--forever` exists for.
 */
export function watchTimeoutSec(
  raw: string | undefined,
  mode: WatchMode,
): number {
  if (raw !== undefined) return parseSeconds(raw, "--timeout");
  return mode.forever ? 600 : 60;
}

/**
 * The retry budgets behind watch/poll commands. A blocking watch is a
 * sentinel: it must ride out a full deploy restart, and on dogfood the
 * server today ignores SIGTERM, so systemd's 90s stop timeout makes every
 * restart a ~92s outage. 14 attempts guarantee ≥135s of retrying even at
 * the jitter floor (~200s typical) before giving up with exit code 4.
 * `--poll` callers expect promptness, so a blip gets two quick retries and
 * a real outage fails fast. `--forever` asked for exactly one ending —
 * entries or a fatal error — so it drops the ceiling and keeps the same
 * capped backoff, which puts exit code 4 out of reach.
 */
export function watchRetryOptions(
  mode: WatchMode,
  onRetry?: (line: string) => void,
  clock: Clock = systemClock,
): RetryOptions {
  const budget = mode.forever
    ? {
        maxAttempts: Number.POSITIVE_INFINITY,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
      }
    : mode.poll
      ? { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 1000 }
      : { maxAttempts: 14, baseDelayMs: 1000, maxDelayMs: 30_000 };
  return { ...budget, onRetry, sleep: clock.sleep };
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff and
 * jitter (delay drawn from [cap/2, cap), cap doubling up to maxDelayMs).
 * Non-transient errors pass through untouched; the `maxAttempts`th
 * consecutive failure throws RetriesExhaustedError (exit code 4). An
 * infinite `maxAttempts` never reaches that throw, so `--forever` needs no
 * branch of its own here — only a progress line with no denominator.
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
      const budget = Number.isFinite(opts.maxAttempts)
        ? `${failures}/${opts.maxAttempts}`
        : `${failures}`;
      opts.onRetry?.(
        `transient failure ${budget} (${describeError(error)}); retrying in ${(delayMs / 1000).toFixed(1)}s`,
      );
      await wait(delayMs);
    }
  }
}

/**
 * The `--forever` heartbeat line, one shape for all three waiting commands
 * so a reader of two feeds side by side is reading the same thing; only
 * `subject` names what this one is waiting on.
 */
export function quietNote(
  subject: string,
  timeoutSec: number,
  totalMs: number,
): string {
  return `${subject} — nothing new in ${timeoutSec}s (${formatDuration(totalMs)} total)`;
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
 * Returns the process exit code: 0 when entries were delivered or a poll
 * finished its one check, 3 when a blocking watch timed out with nothing
 * (loop-friendly "no news"). Under `forever` there is no 3: the timeout
 * becomes a heartbeat interval and the quiet phase re-arms instead.
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
  /** Never return empty-handed: re-arm the quiet phase instead of exiting 3. */
  forever?: boolean;
  timeoutSec: number;
  intervalSec: number;
  /** Batch window after the first batch's newest `created_at`; undefined = emit immediately. */
  debounceSec?: number;
  baseline: string | undefined;
  drain: (
    after: string | undefined,
  ) => Promise<{ items: T[]; cursor: string | undefined }>;
  onItems: (items: T[], cursor: string | undefined) => void;
  /**
   * Standing mode (T-252): decides after each delivered batch whether to
   * keep waiting. Unset keeps the one-shot contract every caller but
   * `watch --follow` relies on, and `"stop"` ends with exit code 0 — the
   * same verdict a one-shot delivery gives, so degrading is indistinguishable
   * to whoever runs the command.
   */
  afterItems?: (
    items: T[],
    cursor: string | undefined,
  ) => Promise<"continue" | "stop">;
  /**
   * Checked at the top of every round; true ends with exit code 0. Standing
   * mode needs this as well as `afterItems` because the reason to stop —
   * a push the session refused — can land during the quiet phase, and
   * without a check there it would go unnoticed until the next batch, which
   * may be hours away. Pairs with a `wait` that the same event cuts short.
   */
  shouldStop?: () => boolean;
  onEmpty: (cursor: string | undefined) => void;
  /** `forever` only: one heartbeat per elapsed quiet phase, for stderr. */
  onQuiet?: (cursor: string | undefined, totalMs: number) => void;
  /** Overrides the poll-derived transient-failure budget. */
  retry?: RetryOptions;
  /**
   * Every deadline below is read from here, so a test can hand in a virtual
   * clock and settle the timeout and debounce windows by arithmetic (T-127).
   */
  clock?: Clock;
  /**
   * How the loop idles between drains, given the longest wait still useful
   * (the time left on the deadline, or on the debounce window). The default
   * is the poll interval; a push transport hands in a wait that also
   * returns early when the server says there is something to pull (T-123).
   * Either way the loop's arithmetic is unchanged — a wait that ends sooner
   * only means an extra drain, never a different verdict.
   */
  wait?: (maxMs: number) => Promise<void>;
}): Promise<number> {
  let cursor = opts.baseline;
  const clock = opts.clock ?? systemClock;
  const start = clock.now();
  let deadline = start + opts.timeoutSec * 1000;
  const retry =
    opts.retry ??
    watchRetryOptions(
      { poll: opts.poll, forever: opts.forever },
      undefined,
      clock,
    );
  const wait =
    opts.wait ??
    ((maxMs) => clock.sleep(Math.min(opts.intervalSec * 1000, maxMs)));

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
    if (opts.shouldStop?.()) return 0;
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
          await wait(remaining);
          items.push(...(await drainOnce()));
        }
      }
      opts.onItems(items, cursor);
      if (opts.afterItems === undefined) return 0;
      if ((await opts.afterItems(items, cursor)) === "stop") return 0;
      // Same re-arming as the forever quiet phase, and for the same reason:
      // the cursor the loop already holds is the one to carry on from, since
      // asking the server for a fresh "now" would skip whatever landed
      // while this batch was being handed over.
      deadline = clock.now() + opts.timeoutSec * 1000;
      continue;
    }
    if (opts.poll) {
      opts.onEmpty(cursor);
      return 0;
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      if (opts.forever) {
        // Re-arm and carry on with the cursor the loop already holds:
        // asking the server for a fresh "now" position here would skip
        // whatever landed while it was quiet. The heartbeat exists so a
        // reader of the stderr feed can tell waiting apart from wedged.
        opts.onQuiet?.(cursor, clock.now() - start);
        deadline = clock.now() + opts.timeoutSec * 1000;
        continue;
      }
      opts.onEmpty(cursor);
      return 3;
    }
    await wait(remaining);
  }
}
