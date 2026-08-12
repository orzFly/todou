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
 * `timeoutSec` bounds the quiet phase only; once the first entry arrives,
 * `debounceSec` (when set) takes over and keeps batching for that fixed
 * window before emitting, so the process may outlive the timeout by up to
 * the debounce duration.
 */
export async function runWatchLoop<T>(opts: {
  poll: boolean;
  timeoutSec: number;
  intervalSec: number;
  /** Batch window after the first entry; undefined = emit immediately. */
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
        // The window is fixed from the first entry — later entries do not
        // reset it — so sustained activity cannot defer the return forever.
        // Entries landing after it closes stay beyond `cursor` for the
        // caller's next watch.
        const windowEnd = Date.now() + opts.debounceSec * 1000;
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
