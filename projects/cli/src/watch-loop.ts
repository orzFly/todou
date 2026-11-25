import type { TodouClient } from "@todou/shared";
import {
  TimelineFilterType,
  TodouError,
  TodouNetworkError,
} from "@todou/shared";
import { type Clock, systemClock } from "./clock.ts";
import { CliError, RetriesExhaustedError } from "./errors.ts";
import { formatDuration } from "./format.ts";
import type { LiveSession } from "./harness/types.ts";
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
 * 5xx/408/429 are server-side or throttling hiccups; the shared client
 * marks fetch and body-stream failures. Legacy TypeErrors remain retryable.
 * Everything else — 4xx, parse errors, bugs, cancellations — is fatal.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof TodouError) {
    return error.status >= 500 || error.status === 408 || error.status === 429;
  }
  return error instanceof TodouNetworkError || error instanceof TypeError;
}

export function describeError(error: unknown): string {
  if (error instanceof TodouError) {
    return error.message === String(error.status)
      ? `HTTP ${error.status}`
      : `HTTP ${error.status} — ${error.message}`;
  }
  if (error instanceof TodouNetworkError || error instanceof TypeError) {
    const cause = error.cause;
    if (cause instanceof Error) {
      return cause.cause instanceof Error ? cause.cause.message : cause.message;
    }
    return error.message;
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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A verified native owner retired; never retry an aborted watch. */
  signal?: AbortSignal;
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

/** `--rendered` is a field on `--json` item lines; alone it has no home. */
export function checkRendered(rendered: boolean, json: boolean): void {
  if (rendered && !json) {
    throw new CliError(
      "--rendered only makes sense with --json",
      "add --json — without it every entry already prints as rendered text",
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
 * sentinel: it must ride out a full deploy restart, and on our deployment
 * the server today ignores SIGTERM, so systemd's 90s stop timeout makes
 * every restart a ~92s outage. 14 attempts guarantee ≥135s of retrying even at
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
    opts.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      opts.signal?.throwIfAborted();
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
      await wait(delayMs, opts.signal);
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
  held = 0,
): string {
  const holding =
    held > 0 ? `; ${held} minor ${held === 1 ? "entry" : "entries"} held` : "";
  return `${subject} — nothing new in ${timeoutSec}s (${formatDuration(totalMs)} total${holding})`;
}

/** Query parameters that spell "not mine" for the watch endpoints. */
export type SelfFilter = {
  excludeActor?: number;
  excludeAgentSession?: string;
};

/**
 * The same thing asked per drain rather than answered once. A watch outlives
 * the session id it was born with — `/clear` rotates it under a live process
 * — so a filter captured at startup goes on naming a session that no longer
 * exists, and the watch's own session's writes come back to it as news
 * (T-289).
 */
export type SelfFilterSource = { params(): Promise<SelfFilter> };

/** A filter with nothing to re-read: `--any-actor`, `--exclude-actor`. */
export function fixedSelfFilter(params: SelfFilter): SelfFilterSource {
  return { params: async () => params };
}

/** Who this process is, both as the harness reports it now and as it began. */
export type SessionSource = {
  live(): Promise<LiveSession>;
  /** What the environment said when this process was spawned. */
  startup: string | undefined;
};

/**
 * The default self-filter of every watch: this agent session's own writes,
 * falling back to this account for entries no session claims (T-121). Both
 * axes travel together — see the `exclude_agent_session` schema for how the
 * server composes them.
 *
 * The account is resolved once, being a network round trip and unable to
 * rotate; the session is read again on every `params()`. `note` is the
 * caller's stderr, and a caller with nothing long-lived to say passes none.
 */
export async function resolveSelfFilter(
  client: TodouClient,
  session: SessionSource,
  retry: RetryOptions,
  note?: (line: string) => void,
): Promise<SelfFilterSource> {
  const excludeActor = (await retryTransient(() => client.me(), retry)).id;
  let seen: string | undefined;
  let asked = false;
  let saidUnreadable = false;
  return {
    async params() {
      const live = await session.live();
      if (live.unreadable !== undefined && !saidUnreadable) {
        saidUnreadable = true;
        // Stated as its consequence, not as its cause: falling back to the
        // startup value *is* the bug T-289 fixed, so a lookup that never
        // succeeds would otherwise leave the old behaviour in place while
        // the card read as closed.
        note?.(
          `could not read ${live.unreadable}: the self-filter stays on the ` +
            "session id this process started with, and will not follow a /clear",
        );
      }
      // `||`, not `??`: a harness may report an empty session id, which names
      // nothing to filter on — and the server rejects it as a query param.
      const id = live.id || session.startup || undefined;
      // Nothing at startup, where the live value and the environment agree;
      // and nothing for an id that went away, which the line above covers.
      if (asked && id !== seen && id !== undefined && seen !== undefined) {
        note?.(`session id rotated ${seen} → ${id}; self-filter follows`);
      }
      asked = true;
      seen = id;
      return { excludeActor, excludeAgentSession: id };
    },
  };
}

/**
 * The shared poll-until-news loop behind `issue watch` and `watch`.
 * Returns the process exit code: 0 when entries were delivered or a poll
 * finished its one check, 3 when a blocking watch timed out with nothing
 * (loop-friendly "no news"). Under `forever` there is no 3: the timeout
 * becomes a heartbeat interval and the quiet phase re-arms instead.
 *
 * Every held entry gets its own due time — when it *happened*
 * (`created_at`, or when this watcher saw it if that is earlier) plus the
 * window of its tier — and the whole batch goes out at the earliest one
 * (T-694). An arrival can only bring that moment forward, never push it
 * back, so a stream of entries cannot keep the batch waiting; and a resume
 * that back-fills old history is already overdue and returns immediately.
 * A held reference therefore leaves with the next comment, or alone once
 * its own longer window runs out.
 *
 * `timeoutSec` bounds the quiet phase, and held minor entries do not end
 * it: they are not worth waking anyone for. A one-shot watch that reaches
 * its deadline holding only those returns them with exit 0 — the cursor may
 * not pass entries nobody printed, so exiting 3 without them would lose
 * them. Once an urgent entry is held the deadline stops counting and the
 * process may outlive it by up to that entry's window.
 *
 * The heartbeat's cursor stops short of held entries (`heldFrom`): a
 * standing watch hands it out as the `--since` to resume from, and a fatal
 * error exits without flushing what is held, so a cursor past them would
 * skip them on restart.
 */
export async function runWatchLoop<T extends { created_at: string }>(opts: {
  poll: boolean;
  /** Never return empty-handed: re-arm the quiet phase instead of exiting 3. */
  forever?: boolean;
  timeoutSec: number;
  intervalSec: number;
  /**
   * The two windows entries wait in before delivery; `deferSec` may be
   * infinite, holding minor entries until something else carries them.
   * Unset delivers every entry as soon as it is drained.
   */
  batching?: {
    debounceSec: number;
    deferSec: number;
    isMinor: (item: T) => boolean;
  };
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
  /** Independent lifetime cancellation, including requests and retries. */
  signal?: AbortSignal;
  /** Flush collected entries directly, without pushing into a retired session. */
  onStop?: (items: T[], cursor: string | undefined) => void;
  onEmpty: (cursor: string | undefined) => void;
  /**
   * `forever` only: one heartbeat per elapsed quiet phase, for stderr.
   * `held` counts the minor entries waiting, and the cursor stops short of
   * them.
   */
  onQuiet?: (cursor: string | undefined, totalMs: number, held: number) => void;
  /** Overrides the poll-derived transient-failure budget. */
  retry?: RetryOptions;
  /**
   * Every deadline below is read from here, so a test can hand in a virtual
   * clock and settle the timeout and batching windows by arithmetic (T-127).
   */
  clock?: Clock;
  /**
   * How the loop idles between drains, given the longest wait still useful
   * (the time left on the deadline, or until the batch is due). The default
   * is the poll interval; a push transport hands in a wait that also
   * returns early when the server says there is something to pull (T-123).
   * Either way the loop's arithmetic is unchanged — a wait that ends sooner
   * only means an extra drain, never a different verdict.
   */
  wait?: (maxMs: number) => Promise<void>;
}): Promise<number> {
  let cursor = opts.baseline;
  let pending: T[] = [];
  let flushAt = Number.POSITIVE_INFINITY;
  let urgentHeld = false;
  let heldFrom = cursor;
  const clock = opts.clock ?? systemClock;
  const start = clock.now();
  let deadline = start + opts.timeoutSec * 1000;
  const retry = {
    ...(opts.retry ??
      watchRetryOptions(
        { poll: opts.poll, forever: opts.forever },
        undefined,
        clock,
      )),
    signal: opts.signal ?? opts.retry?.signal,
  };
  const wait =
    opts.wait ??
    ((maxMs) =>
      clock.sleep(Math.min(opts.intervalSec * 1000, maxMs), opts.signal));
  const stopped = () => opts.signal?.aborted || opts.shouldStop?.();

  // Advance only after a complete drain: cancellation of a partial page
  // leaves the held cursor safe to resume, including through an outage.
  const drainOnce = async (): Promise<T[]> => {
    const page = await retryTransient(() => opts.drain(cursor), retry);
    cursor = page.cursor ?? cursor;
    return page.items;
  };
  const hold = (items: T[]) => {
    for (const item of items) {
      const minor = opts.batching?.isMinor(item) ?? false;
      const windowSec = minor
        ? (opts.batching?.deferSec ?? 0)
        : (opts.batching?.debounceSec ?? 0);
      const at = Math.min(clock.now(), Date.parse(item.created_at) || 0);
      flushAt = Math.min(flushAt, at + windowSec * 1000);
      if (!minor) urgentHeld = true;
      pending.push(item);
    }
  };
  const flushStop = () => {
    if (opts.onStop !== undefined) opts.onStop(pending, cursor);
    else if (pending.length > 0) opts.onItems(pending, cursor);
    pending = [];
    return 0;
  };

  try {
    for (;;) {
      if (stopped()) return flushStop();
      if (pending.length === 0) heldFrom = cursor;
      hold(await drainOnce());
      if (stopped()) return flushStop();
      const now = clock.now();
      if (
        pending.length > 0 &&
        (opts.poll ||
          now >= flushAt ||
          (!opts.forever && !urgentHeld && now >= deadline))
      ) {
        const items = pending;
        opts.onItems(items, cursor);
        // Ownership passes to stdout or afterItems. Follow's finish owns
        // unconfirmed pushes, so these must not also enter the stop flush.
        pending = [];
        flushAt = Number.POSITIVE_INFINITY;
        urgentHeld = false;
        if (opts.afterItems === undefined) return 0;
        if ((await opts.afterItems(items, cursor)) === "stop") return 0;
        deadline = clock.now() + opts.timeoutSec * 1000;
        continue;
      }
      if (opts.poll) {
        opts.onEmpty(cursor);
        return 0;
      }
      if (!urgentHeld && now >= deadline) {
        if (opts.forever) {
          opts.onQuiet?.(
            pending.length > 0 ? heldFrom : cursor,
            now - start,
            pending.length,
          );
          deadline = now + opts.timeoutSec * 1000;
          continue;
        }
        // Not reached holding entries: a one-shot watch past its deadline
        // with nothing urgent held delivered them above.
        opts.onEmpty(cursor);
        return 3;
      }
      await wait(
        Math.min(flushAt, urgentHeld ? Number.POSITIVE_INFINITY : deadline) -
          clock.now(),
      );
    }
  } catch (error) {
    if (opts.signal?.aborted) return flushStop();
    throw error;
  }
}
