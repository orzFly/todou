import { describe, expect, it } from "vitest";
import { detectRenames } from "../src/spec-rename.ts";

/** Ten distinct four-byte lines, so a kept subset is a share of the whole. */
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `l${i}\n`).join("");
const keep = (count: number) =>
  Array.from({ length: count }, (_, i) => `l${i}\n`).join("");

const snapshot = (files: Record<string, string>) =>
  new Map(Object.entries(files));

describe("detectRenames", () => {
  it("pairs a file whose body survived the move untouched", () => {
    expect(
      detectRenames(
        snapshot({ "old.md": "same\n", "kept.md": "kept\n" }),
        snapshot({ "new.md": "same\n", "kept.md": "kept\n" }),
      ),
    ).toEqual([{ from: "old.md", to: "new.md", identical: true }]);
  });

  it("pairs at half the larger side and no less", () => {
    const before = snapshot({ "old.md": TEN_LINES });
    expect(detectRenames(before, snapshot({ "new.md": keep(6) }))).toEqual([
      { from: "old.md", to: "new.md", identical: false },
    ]);
    // 20 of 40 bytes carried over: exactly git's -M50%, which pairs.
    expect(detectRenames(before, snapshot({ "new.md": keep(5) }))).toEqual([
      { from: "old.md", to: "new.md", identical: false },
    ]);
    expect(detectRenames(before, snapshot({ "new.md": keep(4) }))).toEqual([]);
  });

  it("weighs lines by their bytes, not their characters", () => {
    // The CJK line is 28 of the source's 46 bytes but only 10 of its 28
    // characters — byte-weighted it clears the threshold, counted it does not.
    const before = snapshot({
      "old.md": `${"中".repeat(9)}\n${"a\n".repeat(9)}`,
    });
    const after = snapshot({ "new.md": `${"中".repeat(9)}\n` });
    expect(detectRenames(before, after)).toEqual([
      { from: "old.md", to: "new.md", identical: false },
    ]);
  });

  it("gives a source to its closest target and leaves the rest added", () => {
    expect(
      detectRenames(
        snapshot({ "old.md": TEN_LINES }),
        snapshot({ "far.md": keep(6), "near.md": keep(9) }),
      ),
    ).toEqual([{ from: "old.md", to: "near.md", identical: false }]);
  });

  it("never pairs an empty file, which carries no identity", () => {
    expect(
      detectRenames(
        snapshot({ "empty.md": "", "old.md": "body\n" }),
        snapshot({ "blank.md": "", "new.md": "body\n" }),
      ),
    ).toEqual([{ from: "old.md", to: "new.md", identical: true }]);
  });

  it("breaks ties by path, whatever order the snapshots were built in", () => {
    const exact = (files: Record<string, string>) => snapshot(files);
    expect(
      detectRenames(
        exact({ "old.md": "body\n" }),
        exact({ "z.md": "body\n", "a.md": "body\n" }),
      ),
    ).toEqual([{ from: "old.md", to: "a.md", identical: true }]);
    // Two targets that kept different halves score the same; path order picks.
    const before = exact({ "old.md": TEN_LINES });
    const scored = [
      detectRenames(before, exact({ "b.md": keep(6), "a.md": keep(6) })),
      detectRenames(before, exact({ "a.md": keep(6), "b.md": keep(6) })),
    ];
    expect(scored[0]).toEqual([
      { from: "old.md", to: "a.md", identical: false },
    ]);
    expect(scored[1]).toEqual(scored[0]);
  });

  it("returns nothing when one side of the candidate set is empty", () => {
    expect(
      detectRenames(
        snapshot({ "a.md": "one\n" }),
        snapshot({ "a.md": "one\n", "b.md": "two\n" }),
      ),
    ).toEqual([]);
    expect(
      detectRenames(
        snapshot({ "a.md": "one\n", "b.md": "two\n" }),
        snapshot({ "a.md": "one\n" }),
      ),
    ).toEqual([]);
  });

  it("orders several renames by their new path", () => {
    expect(
      detectRenames(
        snapshot({ "z-old.md": "zed\n", "a-old.md": "ay\n" }),
        snapshot({ "b-new.md": "zed\n", "a-new.md": "ay\n" }),
      ),
    ).toEqual([
      { from: "a-old.md", to: "a-new.md", identical: true },
      { from: "z-old.md", to: "b-new.md", identical: true },
    ]);
  });
});
