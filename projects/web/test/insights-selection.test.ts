import { describe, expect, it } from "vitest";
import {
  dayCoverage,
  spanContains,
  spanOverlap,
  type TimeSpan,
} from "@/lib/insights-selection.ts";

const HOUR = 60 * 60 * 1000;

const day: TimeSpan = {
  start: Date.UTC(2026, 8, 20),
  end: Date.UTC(2026, 8, 21),
};

/** Hours into `day`, as an instant. */
const at = (hours: number) => day.start + hours * HOUR;

/** Apia skipped 2011-12-30 entirely, so its cell covers a single instant. */
const skippedDay: TimeSpan = {
  start: Date.UTC(2011, 11, 30, 10),
  end: Date.UTC(2011, 11, 30, 10),
};

describe("spanOverlap", () => {
  it("returns the shared range", () => {
    expect(spanOverlap(day, { start: at(18), end: at(30) })).toEqual({
      start: at(18),
      end: day.end,
    });
  });

  it("returns the inner range when one contains the other", () => {
    const inner = { start: at(6), end: at(9) };
    expect(spanOverlap(day, inner)).toEqual(inner);
    expect(spanOverlap(inner, day)).toEqual(inner);
  });

  it("returns null for disjoint ranges", () => {
    expect(spanOverlap(day, { start: at(48), end: at(72) })).toBeNull();
    expect(spanOverlap({ start: at(48), end: at(72) }, day)).toBeNull();
  });

  it("returns null when the ranges only touch", () => {
    expect(spanOverlap(day, { start: day.end, end: at(48) })).toBeNull();
    expect(spanOverlap(day, { start: at(-24), end: day.start })).toBeNull();
  });
});

describe("spanContains", () => {
  it("includes the start and every instant up to the end", () => {
    expect(spanContains(day, day.start)).toBe(true);
    expect(spanContains(day, at(12))).toBe(true);
    expect(spanContains(day, day.end - 1)).toBe(true);
  });

  it("excludes the end, which belongs to the next day", () => {
    expect(spanContains(day, day.end)).toBe(false);
  });

  it("excludes instants outside the range", () => {
    expect(spanContains(day, day.start - 1)).toBe(false);
    expect(spanContains(day, at(48))).toBe(false);
  });
});

describe("dayCoverage", () => {
  it("returns null when the selection misses the day", () => {
    expect(dayCoverage(day, { start: at(48), end: at(72) })).toBeNull();
  });

  it("fills from the top when the selection starts before the day", () => {
    expect(dayCoverage(day, { start: at(-12), end: at(6) })).toEqual([0, 0.25]);
  });

  it("fills to the bottom when the selection runs past the day", () => {
    expect(dayCoverage(day, { start: at(18), end: at(36) })).toEqual([0.75, 1]);
  });

  it("fills the whole cell when the selection covers the day", () => {
    expect(dayCoverage(day, { start: at(-24), end: at(48) })).toEqual([0, 1]);
    expect(dayCoverage(day, day)).toEqual([0, 1]);
  });

  it("fills a band when the selection sits inside one day", () => {
    expect(dayCoverage(day, { start: at(6), end: at(18) })).toEqual([
      0.25, 0.75,
    ]);
  });

  it("returns null for a skipped civil date rather than dividing by zero", () => {
    expect(
      dayCoverage(skippedDay, {
        start: skippedDay.start - HOUR,
        end: skippedDay.end + HOUR,
      }),
    ).toBeNull();
  });

  it("returns null when the selection ends exactly at the day's start", () => {
    expect(dayCoverage(day, { start: at(-12), end: day.start })).toBeNull();
  });

  it("returns null when the selection starts exactly at the day's end", () => {
    expect(dayCoverage(day, { start: day.end, end: at(36) })).toBeNull();
  });

  it("covers the day's own edges", () => {
    expect(dayCoverage(day, { start: day.start, end: at(1) })).toEqual([
      0,
      1 / 24,
    ]);
    expect(dayCoverage(day, { start: at(23), end: day.end })).toEqual([
      23 / 24,
      1,
    ]);
  });
});
