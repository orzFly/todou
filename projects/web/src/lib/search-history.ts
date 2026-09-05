/**
 * The search box's own history (T-270), after `autocomplete="off"` took the
 * browser's away: queries kept per browser in localStorage, bucketed by
 * project because a query written against one project's labels and statuses
 * matches nothing in another.
 *
 * The matching core is pure (`now` always passed in); only read/record/forget
 * touch storage, and all of them swallow failures — a list of past queries is
 * never worth breaking a page over.
 */

/** One past query and when it was last run. */
export type SearchHistoryEntry = { q: string; t: number };
/** slug → entries, newest first. */
export type SearchHistory = Record<string, SearchHistoryEntry[]>;

export const HISTORY_LIMIT = 25;
/** Same horizon as project-visits' PRUNE_DAYS: one answer to "how long". */
export const HISTORY_DAYS = 90;

const DAY_MS = 86_400_000;

export function historyKey(userId: number | string): string {
  return `todou:search-history:v1:${userId}`;
}

/** Parse a raw localStorage payload, dropping anything malformed. */
export function parseHistory(raw: string | null): SearchHistory {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const data: SearchHistory = {};
  for (const [slug, entries] of Object.entries(parsed)) {
    if (!Array.isArray(entries)) continue;
    const kept: SearchHistoryEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { q, t } = entry as { q?: unknown; t?: unknown };
      if (typeof q !== "string" || typeof t !== "number") continue;
      kept.push({ q, t });
    }
    data[slug] = kept;
  }
  return data;
}

export function readHistory(userId: number | string): SearchHistory {
  try {
    return parseHistory(localStorage.getItem(historyKey(userId)));
  } catch {
    // Private mode / blocked storage: behave as "no history".
    return {};
  }
}

function write(userId: number | string, data: SearchHistory): void {
  localStorage.setItem(historyKey(userId), JSON.stringify(data));
  announce();
}

export function recordSearch(
  userId: number | string,
  slug: string,
  q: string,
  now: number,
): void {
  try {
    const query = q.trim();
    if (query === "") return;

    const data = readHistory(userId);
    const same = query.toLowerCase();
    // Searching is case-insensitive, so `Bug` and `bug` are one entry; the
    // spelling that survives is the one just typed.
    const bucket = (data[slug] ?? []).filter(
      (entry) => entry.q.toLowerCase() !== same,
    );
    bucket.unshift({ q: query, t: now });
    data[slug] = bucket.slice(0, HISTORY_LIMIT);

    // Sweep every slug while we hold the object: entries past the horizon go,
    // and slugs left empty (deleted projects included) go with them.
    for (const [s, entries] of Object.entries(data)) {
      const fresh = entries.filter(
        (entry) => now - entry.t <= HISTORY_DAYS * DAY_MS,
      );
      if (fresh.length === 0) delete data[s];
      else data[s] = fresh;
    }

    write(userId, data);
  } catch (error) {
    console.warn("search-history: record failed", error);
  }
}

export function forgetSearch(
  userId: number | string,
  slug: string,
  q: string,
): void {
  try {
    const data = readHistory(userId);
    const entries = data[slug];
    if (entries === undefined) return;
    const same = q.trim().toLowerCase();
    const kept = entries.filter((entry) => entry.q.toLowerCase() !== same);
    if (kept.length === entries.length) return;
    if (kept.length === 0) delete data[slug];
    else data[slug] = kept;
    write(userId, data);
  } catch (error) {
    console.warn("search-history: forget failed", error);
  }
}

/**
 * The two bands an input splits the history into: the entries it prefixes,
 * and the ones it only appears inside.
 *
 * Substring and not prefix alone because `todou search` is itself a substring
 * search and Chinese has no word boundaries — on prefixes only, `补全` never
 * reaches `搜索框 补全`. The weaker band is separated out so it can wait below
 * the search row: a one-character substring matches nearly everything, and
 * that kind of hit does not belong directly under the input.
 *
 * An entry equal to the input is dropped from both — choosing it would do
 * nothing. An empty input prefixes everything, which is what makes a focused
 * empty box list the whole history without a rule of its own.
 */
export function matchHistory(
  entries: SearchHistoryEntry[],
  query: string,
): { starts: SearchHistoryEntry[]; contains: SearchHistoryEntry[] } {
  const typed = query.trim().toLowerCase();
  const starts: SearchHistoryEntry[] = [];
  const contains: SearchHistoryEntry[] = [];
  for (const entry of entries) {
    const q = entry.q.toLowerCase();
    if (q === typed) continue;
    if (q.startsWith(typed)) starts.push(entry);
    else if (q.includes(typed)) contains.push(entry);
  }
  return { starts, contains };
}

const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Changes in this browser: the `storage` event for other tabs, plus this
 * tab's own writes. project-visits needs no second half because it records on
 * navigation and the page re-renders anyway; deleting a history row happens
 * with the panel open and nothing else changing, so without the announcement
 * the deleted row stays on screen.
 */
export function subscribeHistory(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}
