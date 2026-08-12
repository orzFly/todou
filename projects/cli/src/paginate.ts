import { CliError } from "./errors.ts";

/**
 * Backstop for drainPaged: at 100 entries per page this allows 100k entries,
 * far beyond any real timeline, so hitting it means the server keeps minting
 * fresh cursors rather than draining.
 */
export const MAX_DRAIN_PAGES = 1000;

/**
 * Follows next_cursor forward until the stream is drained. `cursor` lands on
 * the newest entry seen (or stays at `after` when nothing was new), so
 * callers can hand it straight back to `--since`. A failure mid-drain
 * surfaces before the caller's cursor moves, so retrying from the same
 * position re-reads this attempt's pages — nothing is lost or repeated.
 *
 * The server promises next_cursor is null exactly on empty pages (filters
 * are applied in SQL, so an empty page never hides more rows). A server that
 * breaks that promise — a cursor that does not advance, or an empty page
 * that still carries one — used to spin this loop forever and OOM the
 * process (#68: ~3M identical requests, ~4 GB RSS in 97s). Both anomalies
 * now end the drain; a stalled page's items are dropped because they sit at
 * or before the cursor we already handed out, so emitting them would break
 * the never-repeat guarantee. MAX_DRAIN_PAGES bounds the remaining case of
 * ever-fresh cursors, loudly.
 */
export async function drainPaged<T>(
  label: string,
  after: string | undefined,
  fetchPage: (
    after: string | undefined,
  ) => Promise<{ items: T[]; next_cursor: string | null }>,
): Promise<{ items: T[]; cursor: string | undefined }> {
  const items: T[] = [];
  let cursor = after;
  for (let pages = 1; ; pages += 1) {
    const page = await fetchPage(after);
    const next = page.next_cursor ?? undefined;
    if (next !== undefined && next === after) break;
    if (page.items.length === 0) break;
    items.push(...page.items);
    if (next === undefined) break;
    if (pages >= MAX_DRAIN_PAGES) {
      throw new CliError(
        `giving up after ${MAX_DRAIN_PAGES} ${label} pages — the server keeps returning another next_cursor`,
        "this is a server-side pagination anomaly, not a CLI usage error; nothing was printed, so it is safe to retry once the server is fixed",
      );
    }
    cursor = next;
    after = next;
  }
  return { items, cursor };
}
