import { describe, expect, it } from "vitest";
import {
  formatAnchorRange,
  SpecCommentAnchor,
  SpecCommentAnchorInput,
} from "../src/index.ts";

const base = { path: "design.md", version: 2 };

describe("SpecCommentAnchorInput columns (T-142)", () => {
  it("accepts an anchor with no columns at all", () => {
    const parsed = SpecCommentAnchorInput.parse({
      ...base,
      line_start: 5,
      line_end: 7,
    });
    expect(parsed.col_start).toBeUndefined();
  });

  it("accepts a column range inside one line and across lines", () => {
    expect(
      SpecCommentAnchorInput.safeParse({
        ...base,
        line_start: 5,
        line_end: 5,
        col_start: 12,
        col_end: 34,
      }).success,
    ).toBe(true);
    expect(
      SpecCommentAnchorInput.safeParse({
        ...base,
        line_start: 5,
        line_end: 7,
        col_start: 30,
        col_end: 4,
      }).success,
    ).toBe(true);
  });

  it("rejects one column without the other", () => {
    for (const half of [{ col_start: 3 }, { col_end: 3 }]) {
      expect(
        SpecCommentAnchorInput.safeParse({
          ...base,
          line_start: 5,
          line_end: 5,
          ...half,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects columns on a file-level anchor", () => {
    expect(
      SpecCommentAnchorInput.safeParse({
        ...base,
        col_start: 3,
        col_end: 9,
      }).success,
    ).toBe(false);
  });

  it("rejects a backwards column range within one line", () => {
    expect(
      SpecCommentAnchorInput.safeParse({
        ...base,
        line_start: 5,
        line_end: 5,
        col_start: 30,
        col_end: 4,
      }).success,
    ).toBe(false);
  });

  it("rejects zero and fractional columns", () => {
    for (const cols of [
      { col_start: 0, col_end: 4 },
      { col_start: 1.5, col_end: 4 },
    ]) {
      expect(
        SpecCommentAnchorInput.safeParse({
          ...base,
          line_start: 5,
          line_end: 5,
          ...cols,
        }).success,
      ).toBe(false);
    }
  });
});

describe("SpecCommentAnchor storage form", () => {
  it("parses a pre-T-142 anchor that has no column keys", () => {
    const parsed = SpecCommentAnchor.parse({
      path: "design.md",
      version: 1,
      line_start: 3,
      line_end: 3,
      quote: "old row",
    });
    expect(parsed.col_start).toBeNull();
    expect(parsed.col_end).toBeNull();
  });

  it("keeps explicit columns", () => {
    const parsed = SpecCommentAnchor.parse({
      path: "design.md",
      version: 1,
      line_start: 3,
      line_end: 3,
      col_start: 2,
      col_end: 8,
      quote: "he lin",
    });
    expect(parsed.col_start).toBe(2);
  });
});

describe("formatAnchorRange", () => {
  it("spells every form", () => {
    expect(formatAnchorRange({ line_start: null, line_end: null })).toBe(
      "file",
    );
    expect(formatAnchorRange({})).toBe("file");
    expect(formatAnchorRange({ line_start: 5, line_end: 5 })).toBe("L5");
    expect(formatAnchorRange({ line_start: 5, line_end: 7 })).toBe("L5–7");
    expect(
      formatAnchorRange({
        line_start: 5,
        line_end: 5,
        col_start: 12,
        col_end: 34,
      }),
    ).toBe("L5:12–34");
    expect(
      formatAnchorRange({
        line_start: 5,
        line_end: 7,
        col_start: 12,
        col_end: 34,
      }),
    ).toBe("L5:12–L7:34");
  });

  it("ignores a half-filled column pair", () => {
    expect(
      formatAnchorRange({ line_start: 5, line_end: 5, col_start: 12 }),
    ).toBe("L5");
  });
});
