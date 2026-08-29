import { describe, expect, it } from "vitest";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";
import { beginEdit, retarget } from "../src/lib/spec-staging.ts";

// T-159: the composer is keyed by session, not by anchor, so re-aiming
// mid-sentence no longer throws the sentence away.

const FIRST = {
  path: "design.md",
  version: 2,
  lineStart: 3,
  lineEnd: 4,
  colStart: null,
  colEnd: null,
  quote: "first anchor",
};

const SECOND = {
  path: "design.md",
  version: 2,
  lineStart: 9,
  lineEnd: 9,
  colStart: 5,
  colEnd: 12,
  quote: "second anchor",
};

const DRAFT: SpecReviewDraft = {
  id: "d1",
  anchor: {
    path: "plan.md",
    version: 3,
    line_start: 12,
    line_end: 12,
    col_start: 4,
    col_end: 20,
  },
  quote: "half a sentence",
  body: "needs a caveat",
};

describe("retarget", () => {
  it("opens a session when the composer is closed", () => {
    expect(retarget(null, FIRST, 7)).toEqual({ ...FIRST, session: 7 });
  });

  it("swaps the anchor without ending the open session", () => {
    const open = retarget(null, FIRST, 7);
    const moved = retarget(open, SECOND, 8);
    expect(moved.session).toBe(7);
    expect(moved).toMatchObject({
      lineStart: 9,
      colStart: 5,
      colEnd: 12,
      quote: "second anchor",
    });
  });

  it("keeps pointing at the draft being edited", () => {
    const editing = beginEdit(DRAFT, 3);
    const moved = retarget(editing, SECOND, 4);
    expect(moved.draftId).toBe("d1");
    expect(moved.session).toBe(3);
    expect(moved.path).toBe("design.md");
  });
});

describe("beginEdit", () => {
  it("opens a new session carrying the draft's anchor", () => {
    expect(beginEdit(DRAFT, 5)).toEqual({
      path: "plan.md",
      version: 3,
      lineStart: 12,
      lineEnd: 12,
      colStart: 4,
      colEnd: 20,
      quote: "half a sentence",
      draftId: "d1",
      session: 5,
    });
  });

  it("opens a new session even while one is already running", () => {
    const open = retarget(null, FIRST, 7);
    expect(beginEdit(DRAFT, 8).session).toBe(8);
    expect(open.session).toBe(7);
  });

  it("reads a file-level draft as a file-level anchor (T-61)", () => {
    const fileLevel: SpecReviewDraft = {
      ...DRAFT,
      anchor: {
        ...DRAFT.anchor,
        line_start: null,
        line_end: null,
        col_start: null,
        col_end: null,
      },
    };
    expect(beginEdit(fileLevel, 1)).toMatchObject({
      lineStart: null,
      lineEnd: null,
      colStart: null,
      colEnd: null,
    });
  });
});
