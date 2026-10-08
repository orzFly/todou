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

function readStorage(key: string): SpecReviewDraft[] {
  // Entry-by-entry, not whole-array: one malformed entry (a draft written by
  // an older build whose anchor no longer parses) used to fail the whole
  // z.array() parse, hide every healthy draft, and let the next write bury
  // them (T-518). Unparseable entries are dropped; the rest survive.
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const entries: unknown[] = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const parsed = Draft.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    // Broken storage (privacy mode, corrupted JSON) degrades to no drafts.
    return [];
  }
}

function read(key: string): SpecReviewDraft[] {
  const cached = cache.get(key);
  if (cached) return cached;
  const drafts = readStorage(key);
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

// Another tab writing the same bucket fires `storage` here. Without this the
// cache keeps serving the snapshot this page read at mount, and this page's
// next write resurrects it wholesale — silently deleting the other tab's
// drafts (T-518).
window.addEventListener("storage", (event) => {
  if (event.key === null) {
    // localStorage.clear() in another tab: every bucket is gone.
    cache.clear();
  } else if (event.key.startsWith("todou-spec-review:")) {
    cache.delete(event.key);
  } else {
    return;
  }
  for (const notify of listeners) notify();
});

function sameDraft(left: SpecReviewDraft, right: SpecReviewDraft): boolean {
  return (
    left.id === right.id &&
    left.body === right.body &&
    left.quote === right.quote &&
    left.anchor.path === right.anchor.path &&
    left.anchor.version === right.anchor.version &&
    left.anchor.line_start === right.anchor.line_start &&
    left.anchor.line_end === right.anchor.line_end &&
    left.anchor.col_start === right.anchor.col_start &&
    left.anchor.col_end === right.anchor.col_end
  );
}

/**
 * Removes only drafts that are still byte-for-byte the ones a completed
 * review submitted. Edits and additions made while the request was in flight
 * belong to the next review and stay in the bucket.
 */
export function confirmSubmittedSpecReviewDrafts(
  slug: string,
  issueNumber: number,
  submitted: SpecReviewDraft[],
): void {
  const key = storageKey(slug, issueNumber);
  const byId = new Map(submitted.map((draft) => [draft.id, draft]));
  write(
    key,
    read(key).filter((draft) => {
      const snapshot = byId.get(draft.id);
      return snapshot === undefined || !sameDraft(draft, snapshot);
    }),
  );
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
      // Re-reads storage rather than trusting the cache snapshot: with two
      // tabs on one spec, the other tab's stage must survive this tab's
      // write. Ids this tab knows nothing about are appended; ids it does
      // know keep this tab's (freshly acted-on) copy (T-518).
      add: (draft: Omit<SpecReviewDraft, "id">) => {
        const current = read(key);
        const next = [
          ...current,
          { ...draft, id: `d${Date.now()}-${current.length}` },
        ];
        const known = new Set(current.map((d) => d.id));
        const foreign = readStorage(key).filter((d) => !known.has(d.id));
        write(key, [...next, ...foreign]);
      },
      // Editing a staged draft (T-159) rewrites it where it stands: the id
      // and the list position both outlive the edit, so the chip the user
      // opened keeps its place instead of jumping to the end.
      update: (id: string, patch: Omit<SpecReviewDraft, "id">) => {
        const current = read(key);
        if (!current.some((d) => d.id === id)) return;
        write(
          key,
          current.map((d) => (d.id === id ? { ...patch, id } : d)),
        );
      },
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
