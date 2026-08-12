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
 */
export async function runWatchLoop<T>(opts: {
  poll: boolean;
  timeoutSec: number;
  intervalSec: number;
  baseline: string | undefined;
  drain: (
    after: string | undefined,
  ) => Promise<{ items: T[]; cursor: string | undefined }>;
  onItems: (items: T[], cursor: string | undefined) => void;
  onEmpty: (cursor: string | undefined) => void;
}): Promise<number> {
  let cursor = opts.baseline;
  const deadline = Date.now() + opts.timeoutSec * 1000;
  for (;;) {
    const page = await opts.drain(cursor);
    cursor = page.cursor ?? cursor;
    if (page.items.length > 0) {
      opts.onItems(page.items, cursor);
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
