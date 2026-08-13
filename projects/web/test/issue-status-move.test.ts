import type { IssueCounts, Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  effectiveGroup,
  issueSearchSchema,
  patchCountsMove,
  statusScopeOf,
} from "@/api/issues.ts";

const status = (id: number, category: "open" | "closed"): Status => ({
  id,
  name: `s${id}`,
  category,
  color: "#888888",
  position: id,
  is_default: false,
});

describe("patchCountsMove", () => {
  const base: IssueCounts = {
    open: 5,
    closed: 2,
    by_status: { "1": 3, "2": 2 },
  };

  it("shifts the per-status pair within a category", () => {
    expect(patchCountsMove(base, status(1, "open"), status(2, "open"))).toEqual(
      { open: 5, closed: 2, by_status: { "1": 2, "2": 3 } },
    );
  });

  it("adjusts open/closed when the move crosses categories", () => {
    expect(
      patchCountsMove(base, status(1, "open"), status(9, "closed")),
    ).toEqual({ open: 4, closed: 3, by_status: { "1": 2, "2": 2, "9": 1 } });
  });

  it("treats missing keys as zero and keeps drained keys at zero", () => {
    const drained = patchCountsMove(
      { open: 1, closed: 0, by_status: { "1": 1 } },
      status(1, "open"),
      status(2, "open"),
    );
    expect(drained.by_status).toEqual({ "1": 0, "2": 1 });
  });

  it("is a no-op for a same-status move", () => {
    expect(patchCountsMove(base, status(1, "open"), status(1, "open"))).toBe(
      base,
    );
  });
});

describe("statusScopeOf", () => {
  it("recognizes board columns and list groups", () => {
    expect(statusScopeOf(["issues", "p", { board: 7 }])).toBe(7);
    expect(statusScopeOf(["issues", "p", { group: 7 }, { q: "x" }])).toBe(7);
  });

  it("returns null for flat pages and counts keys", () => {
    expect(statusScopeOf(["issues", "p", { category: "open" }])).toBeNull();
    expect(statusScopeOf(["issues", "p"])).toBeNull();
    expect(statusScopeOf(["issues", "p", "counts", {}])).toBeNull();
  });
});

describe("group search param", () => {
  it("defaults to grouped and accepts only the opt-out", () => {
    expect(effectiveGroup(issueSearchSchema.parse({}))).toBe("status");
    expect(effectiveGroup(issueSearchSchema.parse({ group: "none" }))).toBe(
      "none",
    );
    expect(() => issueSearchSchema.parse({ group: "label" })).toThrow();
  });
});
