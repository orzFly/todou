import type { Project } from "@todou/shared";

/**
 * Frecency ordering for projects (#76): visits recorded per browser in
 * localStorage, scored with exponential decay so busy projects float up and
 * stale ones sink. Newly created projects get a fast-decaying bonus derived
 * from server data alone, so they surface even on browsers with no history.
 *
 * The scoring core is pure (no storage, `now` always passed in); only
 * readVisits/recordVisit touch localStorage, and both swallow failures —
 * ordering is a self-healing heuristic, never worth breaking a page over.
 */

export const HALF_LIFE_DAYS = 14;
export const NEW_BONUS = 10;
export const NEW_HALF_LIFE_DAYS = 2;
export const NEW_CUTOFF_DAYS = 14;
export const NEW_BADGE_DAYS = 7;
export const PRUNE_DAYS = 90;
export const DEDUPE_MS = 30 * 60_000;

const DAY_MS = 86_400_000;

/** Per-day visit counts (key = UTC day number) plus the last-counted instant. */
export type VisitEntry = { d: Record<string, number>; t: number };
export type VisitData = Record<string, VisitEntry>;

export function visitsKey(userId: number | string): string {
  return `todou:project-visits:v1:${userId}`;
}

export function dayNumber(epochMs: number): number {
  return Math.floor(epochMs / DAY_MS);
}

export function visitScore(entry: VisitEntry | undefined, now: number): number {
  if (!entry) return 0;
  const today = dayNumber(now);
  let score = 0;
  for (const [day, count] of Object.entries(entry.d)) {
    const age = today - Number(day);
    if (age < 0 || age > PRUNE_DAYS) continue;
    score += count * 0.5 ** (age / HALF_LIFE_DAYS);
  }
  return score;
}

export function creationBonus(createdAt: string, now: number): number {
  const age = Math.max(0, now - Date.parse(createdAt)) / DAY_MS;
  if (Number.isNaN(age) || age > NEW_CUTOFF_DAYS) return 0;
  return NEW_BONUS * 0.5 ** (age / NEW_HALF_LIFE_DAYS);
}

export function projectScore(
  project: Project,
  entry: VisitEntry | undefined,
  now: number,
): number {
  return visitScore(entry, now) + creationBonus(project.created_at, now);
}

export function isNeverVisited(data: VisitData, slug: string): boolean {
  const entry = data[slug];
  return entry === undefined || Object.keys(entry.d).length === 0;
}

/** The badge marks fresh projects you haven't opened yet, on this browser. */
export function hasNewBadge(
  project: Project,
  data: VisitData,
  now: number,
): boolean {
  return (
    isNeverVisited(data, project.slug) &&
    now - Date.parse(project.created_at) <= NEW_BADGE_DAYS * DAY_MS
  );
}

/**
 * Scored projects by score desc (ties: latest-counted first, then newest);
 * zero-score ones (old and never visited here) trail, newest first.
 */
export function orderProjects(
  projects: Project[],
  data: VisitData,
  now: number,
): Project[] {
  const created = (p: Project) => Date.parse(p.created_at);
  return projects
    .map((p) => ({ p, score: projectScore(p, data[p.slug], now) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const at = data[a.p.slug]?.t ?? 0;
      const bt = data[b.p.slug]?.t ?? 0;
      if (bt !== at) return bt - at;
      return created(b.p) - created(a.p);
    })
    .map((x) => x.p);
}

/** Parse a raw localStorage payload, dropping anything malformed. */
export function parseVisits(raw: string | null): VisitData {
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
  const data: VisitData = {};
  for (const [slug, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { d, t } = entry as { d?: unknown; t?: unknown };
    if (typeof t !== "number" || typeof d !== "object" || d === null) continue;
    const buckets: Record<string, number> = {};
    for (const [day, count] of Object.entries(d)) {
      if (Number.isFinite(Number(day)) && typeof count === "number") {
        buckets[day] = count;
      }
    }
    data[slug] = { d: buckets, t };
  }
  return data;
}

export function readVisits(userId: number | string): VisitData {
  try {
    return parseVisits(localStorage.getItem(visitsKey(userId)));
  } catch {
    // Private mode / blocked storage: behave as "no history".
    return {};
  }
}

export function recordVisit(
  userId: number | string,
  slug: string,
  now: number,
): void {
  try {
    const data = readVisits(userId);
    const entry = data[slug];
    if (entry && now - entry.t < DEDUPE_MS) return;

    const today = dayNumber(now);
    const d = entry?.d ?? {};
    d[String(today)] = (d[String(today)] ?? 0) + 1;
    data[slug] = { d, t: now };

    // Sweep every slug while we hold the object: buckets past the horizon
    // go, and slugs left empty (deleted projects included) go with them.
    for (const [s, e] of Object.entries(data)) {
      for (const day of Object.keys(e.d)) {
        if (today - Number(day) > PRUNE_DAYS) delete e.d[day];
      }
      if (Object.keys(e.d).length === 0) delete data[s];
    }

    localStorage.setItem(visitsKey(userId), JSON.stringify(data));
  } catch (error) {
    console.warn("project-visits: record failed", error);
  }
}
