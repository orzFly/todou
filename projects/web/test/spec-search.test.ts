import { describe, expect, it } from "vitest";
import {
  parseSpecSearch,
  specMode,
  specSearchFor,
} from "../src/lib/spec-search.ts";

describe("parseSpecSearch", () => {
  it("keeps the params it recognises", () => {
    expect(
      parseSpecSearch({
        file: "design.md",
        v: "3",
        compare: "1",
        view: "rendered",
      }),
    ).toEqual({ file: "design.md", v: 3, compare: 1, view: "rendered" });
  });

  it("drops values of the wrong shape rather than crashing the route", () => {
    expect(
      parseSpecSearch({ file: 12, v: "x", compare: 0, view: "raw" }),
    ).toEqual({
      file: undefined,
      v: undefined,
      compare: undefined,
      view: undefined,
    });
  });
});

describe("specMode (T-192, orthogonalised by T-200)", () => {
  it("defaults to the previous version, rendered", () => {
    expect(specMode({}, 3, false)).toEqual({ baseline: 2, view: "rendered" });
  });

  it("reads a pinned baseline with no view as the source diff — pre-split links", () => {
    expect(specMode({ compare: 1 }, 3, false)).toEqual({
      baseline: 1,
      view: "source",
    });
  });

  it("honours an explicit view alongside a pinned baseline", () => {
    expect(specMode({ compare: 1, view: "rendered" }, 3, false)).toEqual({
      baseline: 1,
      view: "rendered",
    });
    expect(specMode({ view: "source" }, 3, false)).toEqual({
      baseline: 2,
      view: "source",
    });
  });

  it("leaves the view to the page whenever there is no baseline", () => {
    // Both ways of having none: nothing earlier to compare against, and
    // comparing switched off. The URL says nothing about how a single
    // version is drawn, so neither does this.
    expect(specMode({}, 1, false)).toEqual({ baseline: null, view: null });
    expect(specMode({}, 3, true)).toEqual({ baseline: null, view: null });
    expect(specMode({ view: "source" }, 3, true)).toEqual({
      baseline: null,
      view: null,
    });
  });

  it("lets a pinned baseline outrank the off position", () => {
    expect(specMode({ compare: 2 }, 3, true)).toEqual({
      baseline: 2,
      view: "source",
    });
  });

  it("falls back to the automatic baseline when the pinned one is not behind", () => {
    expect(specMode({ compare: 3 }, 3, false)).toEqual({
      baseline: 2,
      view: "rendered",
    });
    expect(specMode({ compare: 9 }, 2, false)).toEqual({
      baseline: 1,
      view: "rendered",
    });
    // …and an invalid one at v1 still leaves nothing to compare against.
    expect(specMode({ compare: 5 }, 1, false)).toEqual({
      baseline: null,
      view: null,
    });
  });
});

describe("specSearchFor (T-192)", () => {
  const base = { file: "design.md", v: 3, version: 3 } as const;

  it("writes the automatic posture as no params at all", () => {
    expect(specSearchFor({ ...base, baseline: 2, view: "rendered" })).toEqual({
      file: "design.md",
      v: 3,
    });
  });

  it("writes reading without a baseline the same way — off is not shareable", () => {
    expect(
      specSearchFor({ ...base, baseline: null, view: "rendered" }),
    ).toEqual({
      file: "design.md",
      v: 3,
    });
  });

  it("leaves view off the source diff, which is what compare alone means", () => {
    expect(specSearchFor({ ...base, baseline: 2, view: "source" })).toEqual({
      file: "design.md",
      v: 3,
      compare: 2,
      view: undefined,
    });
  });

  it("spells out a rendered comparison against an older baseline", () => {
    expect(specSearchFor({ ...base, baseline: 1, view: "rendered" })).toEqual({
      file: "design.md",
      v: 3,
      compare: 1,
      view: "rendered",
    });
  });

  it("round-trips every state back through specMode", () => {
    for (const baseline of [null, 1, 2]) {
      for (const view of ["rendered", "source"] as const) {
        const written = specSearchFor({ ...base, baseline, view });
        const read = specMode(written, 3, baseline === null);
        // A null baseline takes the view with it: neither half of the off
        // position is shareable, so neither survives the round trip.
        expect(read).toEqual({
          baseline,
          view: baseline === null ? null : view,
        });
      }
    }
  });
});
