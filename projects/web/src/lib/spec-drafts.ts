import { useCallback, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * Staged review comments (T-23): drafts live in localStorage until the whole
 * review is submitted in one atomic POST — the server holds no pending
 * state. Keyed per issue (not per version) so drafts staged on v2 survive
 * the reviewer switching versions mid-review; each draft's anchor carries
 * the version it was taken from.
 */
const Draft = z.object({
  id: z.string(),
  anchor: z.object({
    path: z.string(),
    version: z.number().int().positive(),
    // Null = file-level comment (T-61).
    line_start: z.number().int().positive().nullable(),
    line_end: z.number().int().positive().nullable(),
    // Columns (T-142) narrow the anchor inside those lines. Nullish, not
    // nullable: drafts already sitting in localStorage have no such keys
    // and must keep parsing — a schema miss silently drops the whole
    // review the reviewer has been writing.
    col_start: z.number().int().positive().nullish().default(null),
    col_end: z.number().int().positive().nullish().default(null),
  }),
  /** Client-side display copy; the server re-quotes authoritatively. */
  quote: z.string(),
  body: z.string(),
});
export type SpecReviewDraft = z.infer<typeof Draft>;

const storageKey = (slug: string, issueNumber: number) =>
  `todou-spec-review:${slug}:${issueNumber}`;

const listeners = new Set<() => void>();
const cache = new Map<string, SpecReviewDraft[]>();

function read(key: string): SpecReviewDraft[] {
  const cached = cache.get(key);
  if (cached) return cached;
  let drafts: SpecReviewDraft[] = [];
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed = z.array(Draft).safeParse(JSON.parse(raw));
      if (parsed.success) drafts = parsed.data;
    }
  } catch {
    // Broken storage (privacy mode, corrupted JSON) degrades to no drafts.
  }
  cache.set(key, drafts);
  return drafts;
}

function write(key: string, drafts: SpecReviewDraft[]): void {
  cache.set(key, drafts);
  try {
    if (drafts.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(drafts));
  } catch {
    // Storage may be unavailable; in-memory state still drives the UI.
  }
  for (const notify of listeners) notify();
}

export function useSpecReviewDrafts(slug: string, issueNumber: number) {
  const key = storageKey(slug, issueNumber);
  const drafts = useSyncExternalStore(
    useCallback((notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    }, []),
    () => read(key),
  );

  return useMemo(
    () => ({
      drafts,
      add: (draft: Omit<SpecReviewDraft, "id">) =>
        write(key, [
          ...read(key),
          { ...draft, id: `d${Date.now()}-${read(key).length}` },
        ]),
      remove: (id: string) =>
        write(
          key,
          read(key).filter((d) => d.id !== id),
        ),
      clear: () => write(key, []),
    }),
    [key, drafts],
  );
}
