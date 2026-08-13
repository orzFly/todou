import { describe, expect, it } from "vitest";
import {
  canonicalizeLabelName,
  groupLabelsByPrefix,
  labelColorFor,
  labelNearKey,
  PRESET_COLORS,
} from "../src/lib/labels.ts";

describe("canonicalizeLabelName (the name a create actually sends)", () => {
  it("trims and collapses inner whitespace", () => {
    expect(canonicalizeLabelName("  area: web  ")).toBe("area: web");
    expect(canonicalizeLabelName("good\t first   issue")).toBe(
      "good first issue",
    );
  });

  it("leaves canonical names alone", () => {
    expect(canonicalizeLabelName("area:web")).toBe("area:web");
  });
});

describe("labelNearKey (near-duplicate comparison)", () => {
  it("is case-insensitive", () => {
    expect(labelNearKey("Area:Web")).toBe(labelNearKey("area:web"));
  });

  it("collides names differing only around the colon", () => {
    expect(labelNearKey("area: web")).toBe(labelNearKey("area:web"));
    expect(labelNearKey(" Area : Web ")).toBe(labelNearKey("area:web"));
  });

  it("keeps genuinely different names apart", () => {
    expect(labelNearKey("area:web")).not.toBe(labelNearKey("area:cli"));
  });
});

describe("labelColorFor (deterministic default color)", () => {
  it("always lands in the preset palette", () => {
    for (const name of ["area:docs", "x", "标签", "good first issue"]) {
      expect(PRESET_COLORS).toContain(labelColorFor(name));
    }
  });

  it("is stable for the same name", () => {
    expect(labelColorFor("area:docs")).toBe(labelColorFor("area:docs"));
  });
});

describe("groupLabelsByPrefix (B1 grouped rendering)", () => {
  const l = (id: number, name: string) => ({ id, name, color: "#3b82f6" });

  it("groups by first-appearance prefix order and keeps plain labels aside", () => {
    const { groups, plain } = groupLabelsByPrefix([
      l(1, "area:cli"),
      l(2, "area:web"),
      l(3, "good-first-issue"),
      l(4, "kind:bug"),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(["area:", "kind:"]);
    expect(groups[0]?.labels.map((x) => x.name)).toEqual([
      "area:cli",
      "area:web",
    ]);
    expect(plain.map((x) => x.name)).toEqual(["good-first-issue"]);
  });

  it("treats a leading colon as no prefix", () => {
    const { groups, plain } = groupLabelsByPrefix([l(1, ":odd")]);
    expect(groups).toEqual([]);
    expect(plain.map((x) => x.name)).toEqual([":odd"]);
  });

  it("handles the empty list", () => {
    expect(groupLabelsByPrefix([])).toEqual({ groups: [], plain: [] });
  });
});
