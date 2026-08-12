import { TimelineFilterType } from "@todou/shared";
import { CliError } from "./errors.ts";

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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
}): Promise<number> {
  let cursor = opts.baseline;
  const deadline = Date.now() + opts.timeoutSec * 1000;

  // Cursors are absolute stream positions and only advance once a drain
  // has returned, so re-draining with the held cursor after a failure
  // loses nothing and repeats nothing.
  // TODO: back off and retry transient failures (network, 5xx) here
  // instead of aborting the command; give up only after several
  // consecutive failures, keeping 4xx fatal. Both the quiet-phase and the
  // debounce loops drain through this closure, so this is the one seam.
  const drainOnce = async (): Promise<T[]> => {
    const page = await opts.drain(cursor);
    cursor = page.cursor ?? cursor;
    return page.items;
  };

  for (;;) {
    const items = await drainOnce();
    if (items.length > 0) {
      if (opts.debounceSec !== undefined && !opts.poll) {
        // The window is anchored on when the newest entry of this first
        // batch happened, not on when the watcher saw it (#50): resuming
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
          Math.min(Date.now(), newest) + opts.debounceSec * 1000;
        for (;;) {
          const remaining = windowEnd - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(opts.intervalSec * 1000, remaining));
          items.push(...(await drainOnce()));
        }
      }
      opts.onItems(items, cursor);
      return 0;
    }
    const remaining = deadline - Date.now();
    if (opts.poll || remaining <= 0) {
      opts.onEmpty(cursor);
      return 3;
    }
    await sleep(Math.min(opts.intervalSec * 1000, remaining));
  }
}
