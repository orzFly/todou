import { describe, expect, it } from "vitest";
import { placeDraft } from "../src/lib/spec-draft-placement.ts";
import type { SpecReviewDraft } from "../src/lib/spec-drafts.ts";

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

function draft(
  version: number,
  lines: [number, number] | null,
  path = "design.md",
): SpecReviewDraft {
  return {
    id: "d1",
    anchor: {
      path,
      version,
      line_start: lines?.[0] ?? null,
      line_end: lines?.[1] ?? null,
      col_start: null,
      col_end: null,
    },
    quote: "",
    body: "a staged comment",
  };
}

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries));

describe("placeDraft", () => {
  it("keeps a draft's own lines on its own version", () => {
    expect(placeDraft(draft(2, [3, 4]), 2, files({}), undefined)).toEqual({
      kind: "line",
      start: 3,
      end: 4,
    });
  });

  it("keeps a file-level draft on its own version", () => {
    expect(placeDraft(draft(2, null), 2, files({}), undefined)).toEqual({
      kind: "file",
    });
  });

  it("has no place for a draft whose file is gone", () => {
    expect(
      placeDraft(
        draft(1, [3, 4], "other.md"),
        2,
        files({ "design.md": TEN }),
        files({ "other.md": TEN }),
      ),
    ).toEqual({ kind: "unplaced" });
  });

  it("carries a file-level draft to a newer version that still has the file", () => {
    expect(
      placeDraft(draft(1, null), 2, files({ "design.md": TEN }), undefined),
    ).toEqual({ kind: "file" });
  });

  it("waits for the draft's own version to arrive", () => {
    expect(
      placeDraft(draft(1, [3, 4]), 2, files({ "design.md": TEN }), undefined),
    ).toEqual({ kind: "loading" });
  });

  it("has no place for a draft its own version's files do not hold", () => {
    expect(
      placeDraft(
        draft(1, [3, 4]),
        2,
        files({ "design.md": TEN }),
        files({ "renamed.md": TEN }),
      ),
    ).toEqual({ kind: "unplaced" });
  });

  it("moves a draft with the unchanged text around it", () => {
    expect(
      placeDraft(
        draft(1, [3, 4]),
        2,
        files({ "design.md": `new 1\nnew 2\n${TEN}` }),
        files({ "design.md": TEN }),
      ),
    ).toEqual({ kind: "line", start: 5, end: 6 });
  });

  it("has no place for a draft whose lines changed", () => {
    expect(
      placeDraft(
        draft(1, [3, 4]),
        2,
        files({ "design.md": TEN.replace("line 4", "line four") }),
        files({ "design.md": TEN }),
      ),
    ).toEqual({ kind: "unplaced" });
  });
});
