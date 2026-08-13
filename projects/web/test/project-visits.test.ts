import type { Project } from "@todou/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  creationBonus,
  DEDUPE_MS,
  dayNumber,
  isNeverVisited,
  orderProjects,
  parseVisits,
  projectScore,
  readVisits,
  recordVisit,
  type VisitData,
  visitScore,
  visitsKey,
} from "../src/lib/project-visits.ts";

const DAY = 86_400_000;
// A fixed "now" keeps every expectation deterministic.
const NOW = Date.parse("2026-08-13T12:00:00Z");
const TODAY = dayNumber(NOW);

function project(slug: string, createdDaysAgo: number): Project {
  return {
    id: 1,
    slug,
    name: slug,
    description: "",
    created_at: new Date(NOW - createdDaysAgo * DAY).toISOString(),
  };
}

/** Buckets from {daysAgo: count} pairs. */
function entry(
  byAge: Record<number, number>,
  t = NOW - DAY,
): VisitData[string] {
  const d: Record<string, number> = {};
  for (const [age, count] of Object.entries(byAge)) {
    d[String(TODAY - Number(age))] = count;
  }
  return { d, t };
}

afterEach(() => localStorage.clear());

describe("visitScore", () => {
  it("matches the spec's boundary example ordering", () => {
    const burstYesterday = visitScore(entry({ 1: 20 }), NOW);
    const dailyThirty = visitScore(
      entry(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i, 1]))),
      NOW,
    );
    const burstLastWeek = visitScore(entry({ 7: 12, 8: 8 }), NOW);
    // 昨天突击 20 次 ≈ 19 > 每天 1 次×30 天 ≈ 16 > 上周突击 20 次 ≈ 14
    expect(burstYesterday).toBeGreaterThan(dailyThirty);
    expect(dailyThirty).toBeGreaterThan(burstLastWeek);
    expect(burstYesterday).toBeCloseTo(19.0, 0);
    expect(dailyThirty).toBeCloseTo(16.0, 0);
  });

  it("ignores buckets beyond the 90-day horizon", () => {
    expect(visitScore(entry({ 91: 100 }), NOW)).toBe(0);
  });
});

describe("creationBonus", () => {
  it("puts a fresh project ahead of weekly-use scores but below daily drivers", () => {
    const fresh = creationBonus(project("p", 0).created_at, NOW);
    expect(fresh).toBe(10);
  });

  it("decays below a single today-visit within a week", () => {
    const week = creationBonus(project("p", 7).created_at, NOW);
    expect(week).toBeLessThan(1);
    expect(week).toBeGreaterThan(0);
  });

  it("cuts off entirely after 14 days", () => {
    expect(creationBonus(project("p", 15).created_at, NOW)).toBe(0);
  });

  it("treats a slightly-future created_at as brand new, not scoreless", () => {
    expect(creationBonus(new Date(NOW + 60_000).toISOString(), NOW)).toBe(10);
  });

  it("applies to visited projects too — no unvisited gate", () => {
    const fresh = project("fresh", 0);
    const visits = entry({ 0: 1 });
    expect(projectScore(fresh, visits, NOW)).toBe(
      visitScore(visits, NOW) + creationBonus(fresh.created_at, NOW),
    );
  });
});

describe("orderProjects", () => {
  it("scored first by score, zero-score tail by newest creation", () => {
    const daily = project("daily", 200);
    const stale = project("stale", 500);
    const oldNever = project("old-never", 300);
    const newerNever = project("newer-never", 100);
    const freshNever = project("fresh-never", 2);
    const data: VisitData = {
      daily: entry({ 0: 3, 1: 3 }),
      stale: entry({ 40: 2 }, NOW - 40 * DAY),
    };
    const ordered = orderProjects(
      [oldNever, stale, newerNever, daily, freshNever],
      data,
      NOW,
    ).map((p) => p.slug);
    // fresh-never rides its creation bonus (≈5) above stale (≈0.3);
    // the two bonus-less never-visited ones trail, newest first.
    expect(ordered).toEqual([
      "daily",
      "fresh-never",
      "stale",
      "newer-never",
      "old-never",
    ]);
  });

  it("breaks score ties by the most recently counted visit", () => {
    const a = project("a", 300);
    const b = project("b", 300);
    const data: VisitData = {
      a: entry({ 1: 1 }, NOW - DAY),
      b: entry({ 1: 1 }, NOW - DAY / 2),
    };
    expect(orderProjects([a, b], data, NOW).map((p) => p.slug)).toEqual([
      "b",
      "a",
    ]);
  });

  it("lifts a fresh visited project above a busier old one via the bonus", () => {
    const freshVisited = project("fresh-visited", 0);
    const workhorse = project("workhorse", 300);
    const data: VisitData = {
      "fresh-visited": entry({ 0: 1 }),
      workhorse: entry({ 0: 5, 1: 5 }),
    };
    // ≈1+10 vs ≈9.8: only the creation bonus puts fresh-visited on top.
    expect(
      orderProjects([workhorse, freshVisited], data, NOW).map((p) => p.slug),
    ).toEqual(["fresh-visited", "workhorse"]);
  });
});

describe("flags", () => {
  it("isNeverVisited: no entry or empty buckets", () => {
    expect(isNeverVisited({}, "x")).toBe(true);
    expect(isNeverVisited({ x: { d: {}, t: NOW } }, "x")).toBe(true);
    expect(isNeverVisited({ x: entry({ 1: 1 }) }, "x")).toBe(false);
  });
});

describe("parseVisits", () => {
  it("returns empty on corrupt JSON or wrong shapes", () => {
    expect(parseVisits("not json")).toEqual({});
    expect(parseVisits(JSON.stringify([1, 2]))).toEqual({});
    expect(parseVisits(JSON.stringify({ x: { d: "nope", t: 1 } }))).toEqual({});
  });

  it("keeps well-formed entries and drops malformed siblings", () => {
    const raw = JSON.stringify({
      good: { d: { "20000": 2 }, t: 5 },
      bad: { t: "yes" },
    });
    expect(parseVisits(raw)).toEqual({ good: { d: { "20000": 2 }, t: 5 } });
  });
});

describe("recordVisit / readVisits", () => {
  it("counts once per 30-minute window", () => {
    recordVisit(1, "todou", NOW);
    recordVisit(1, "todou", NOW + DEDUPE_MS - 1);
    recordVisit(1, "todou", NOW + DEDUPE_MS + 1);
    const d = readVisits(1).todou.d;
    expect(d[String(TODAY)]).toBe(2);
  });

  it("prunes horizons past 90 days and drops emptied slugs on write", () => {
    localStorage.setItem(
      visitsKey(1),
      JSON.stringify({
        ancient: { d: { [String(TODAY - 120)]: 9 }, t: NOW - 120 * DAY },
        alive: { d: { [String(TODAY - 5)]: 1 }, t: NOW - 5 * DAY },
      }),
    );
    recordVisit(1, "todou", NOW);
    const data = readVisits(1);
    expect(data.ancient).toBeUndefined();
    expect(data.alive).toBeDefined();
    expect(data.todou).toBeDefined();
  });

  it("isolates users by key", () => {
    recordVisit(1, "todou", NOW);
    expect(readVisits(2)).toEqual({});
    expect(readVisits(1).todou).toBeDefined();
  });

  it("resets to empty on corrupt payloads instead of throwing", () => {
    localStorage.setItem(visitsKey(1), "{broken");
    expect(readVisits(1)).toEqual({});
    recordVisit(1, "todou", NOW);
    expect(readVisits(1).todou.d[String(TODAY)]).toBe(1);
  });
});
