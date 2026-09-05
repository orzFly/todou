import { afterEach, describe, expect, it } from "vitest";
import {
  forgetSearch,
  HISTORY_DAYS,
  HISTORY_LIMIT,
  historyKey,
  matchHistory,
  parseHistory,
  readHistory,
  recordSearch,
  type SearchHistoryEntry,
} from "../src/lib/search-history.ts";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-09-05T12:00:00Z");
const USER = 7;

const seed = (data: unknown) =>
  localStorage.setItem(historyKey(USER), JSON.stringify(data));
const bucket = (slug: string) => readHistory(USER)[slug] ?? [];
const queries = (slug: string) => bucket(slug).map((e) => e.q);

afterEach(() => localStorage.clear());

describe("parseHistory", () => {
  it("reads nothing out of nothing", () => {
    expect(parseHistory(null)).toEqual({});
    expect(parseHistory("")).toEqual({});
  });

  it("survives a payload that is not JSON at all", () => {
    expect(parseHistory("{")).toEqual({});
  });

  it("refuses a shape that is not a map of buckets", () => {
    expect(parseHistory("[]")).toEqual({});
    expect(parseHistory('{"todou":"x"}')).toEqual({});
  });

  it("drops the malformed entries and keeps the rest of the bucket", () => {
    const raw = JSON.stringify({
      todou: [{ q: "bug", t: NOW }, { t: NOW }, { q: "x", t: "soon" }, null],
    });
    expect(parseHistory(raw)).toEqual({ todou: [{ q: "bug", t: NOW }] });
  });
});

describe("recordSearch", () => {
  it("puts the newest query first", () => {
    recordSearch(USER, "todou", "bug", NOW);
    recordSearch(USER, "todou", "label:area:web", NOW + 1000);
    expect(queries("todou")).toEqual(["label:area:web", "bug"]);
  });

  it("moves a repeated query up instead of storing it twice", () => {
    recordSearch(USER, "todou", "bug", NOW);
    recordSearch(USER, "todou", "spec", NOW + 1000);
    recordSearch(USER, "todou", "bug", NOW + 2000);
    expect(queries("todou")).toEqual(["bug", "spec"]);
  });

  it("treats one spelling of a query as the same query, keeping the newer", () => {
    // Searching is case-insensitive, so two entries would be two rows for
    // one search.
    recordSearch(USER, "todou", "Bug", NOW);
    recordSearch(USER, "todou", "bug", NOW + 1000);
    expect(queries("todou")).toEqual(["bug"]);
  });

  it("trims, and stores nothing for a query that was only whitespace", () => {
    recordSearch(USER, "todou", "  ", NOW);
    recordSearch(USER, "todou", "  bug  ", NOW + 1000);
    expect(queries("todou")).toEqual(["bug"]);
  });

  it("keeps the newest HISTORY_LIMIT and drops the oldest", () => {
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) {
      recordSearch(USER, "todou", `q${i}`, NOW + i * 1000);
    }
    const kept = queries("todou");
    expect(kept).toHaveLength(HISTORY_LIMIT);
    expect(kept[0]).toBe(`q${HISTORY_LIMIT + 2}`);
    expect(kept).not.toContain("q0");
    expect(kept).not.toContain("q2");
    expect(kept.at(-1)).toBe("q3");
  });

  it("sweeps every project's expired entries, and the buckets left empty", () => {
    seed({ accel: [{ q: "old", t: NOW - (HISTORY_DAYS + 1) * DAY_MS }] });
    recordSearch(USER, "todou", "bug", NOW);
    expect(readHistory(USER)).toEqual({ todou: [{ q: "bug", t: NOW }] });
  });

  it("leaves the other projects' entries alone", () => {
    recordSearch(USER, "accel", "theirs", NOW);
    recordSearch(USER, "todou", "ours", NOW + 1000);
    expect(queries("accel")).toEqual(["theirs"]);
    expect(queries("todou")).toEqual(["ours"]);
  });
});

describe("forgetSearch", () => {
  it("removes the one entry, whichever case it is named in", () => {
    recordSearch(USER, "todou", "Bug", NOW);
    recordSearch(USER, "todou", "spec", NOW + 1000);
    forgetSearch(USER, "todou", "bug");
    expect(queries("todou")).toEqual(["spec"]);
  });

  it("drops the bucket once its last entry is gone", () => {
    recordSearch(USER, "todou", "bug", NOW);
    forgetSearch(USER, "todou", "bug");
    expect(readHistory(USER)).toEqual({});
  });
});

describe("matchHistory", () => {
  const entry = (q: string): SearchHistoryEntry => ({ q, t: NOW });
  const ENTRIES = ["补全 面板 排序", "搜索框 补全", "label:area:web"].map(
    entry,
  );
  const both = (query: string) => {
    const { starts, contains } = matchHistory(ENTRIES, query);
    return {
      starts: starts.map((e) => e.q),
      contains: contains.map((e) => e.q),
    };
  };

  it("offers the whole history to an empty box", () => {
    expect(both("")).toEqual({
      starts: ENTRIES.map((e) => e.q),
      contains: [],
    });
  });

  it("splits a prefix hit from one that is only a substring", () => {
    expect(both("补全")).toEqual({
      starts: ["补全 面板 排序"],
      contains: ["搜索框 补全"],
    });
  });

  it("leaves out the entry the box already holds", () => {
    // Choosing it would rewrite the query as itself.
    expect(both("搜索框 补全")).toEqual({
      starts: [],
      contains: [],
    });
  });

  it("does not care which case the query was typed in", () => {
    expect(both("LABEL:")).toEqual(both("label:"));
    expect(both("LABEL:").starts).toEqual(["label:area:web"]);
  });

  it("keeps each band in the order it was given", () => {
    const older = [entry("bug a"), entry("bug b"), entry("bug c")];
    expect(matchHistory(older, "bug").starts.map((e) => e.q)).toEqual([
      "bug a",
      "bug b",
      "bug c",
    ]);
  });
});
