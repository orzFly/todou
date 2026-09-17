import { describe, expect, it } from "vitest";
import { canonicalForDiff } from "../src/lib/spec-canonical.ts";

const FENCE = "前言。\n\n```\n3. foo\n4. bar\n```\n\n结语。\n";
const QUOTED_TABLE = "> | a   | b |\n> | --- | --- |\n> | 1   | 2 |\n";
const FRONTMATTER = "---\ntitle: 1. x\n---\n\n正文。\n";

const SAMPLES: Array<{ what: string; source: string; rewritten: boolean }> = [
  {
    what: "an ordered list",
    source: "1. alpha\n2. beta\n3. gamma\n",
    rewritten: true,
  },
  {
    what: "wide marker gaps",
    source: "1.    alpha\n2.     beta\n",
    rewritten: true,
  },
  { what: "paren delimiters", source: "1) alpha\n2) beta\n", rewritten: true },
  { what: "mixed bullets", source: "- a\n* b\n+ c\n", rewritten: true },
  { what: "a task list", source: "- [x] done\n- [ ] open\n", rewritten: true },
  { what: "an item with no content", source: "-\n- b\n", rewritten: true },
  {
    what: "a nested list",
    source: "1. a\n   - b\n   - c\n2. d\n",
    rewritten: true,
  },
  {
    what: "a table",
    source: "| a | b |\n|---|---|\n| 1 | 2 |\n",
    rewritten: true,
  },
  {
    what: "a table without outer pipes",
    source: "a | b\n--- | ---\n1 | 2\n",
    rewritten: true,
  },
  {
    what: "an aligned table",
    source: "| a | b |\n|:--|--:|\n| 1 | 2 |\n",
    rewritten: true,
  },
  { what: "a quoted table", source: QUOTED_TABLE, rewritten: true },
  {
    what: "an escaped pipe",
    source: "| a | b |\n|---|---|\n| 3 \\| x | 4 |\n",
    rewritten: true,
  },
  { what: "a soft line break", source: "alpha \nbeta\n", rewritten: true },
  {
    what: "a document with no closing newline",
    source: "1. a\n2. b",
    rewritten: true,
  },
  { what: "a hard line break", source: "alpha  \nbeta\n", rewritten: false },
  {
    what: "a backslash line break",
    source: "alpha\\\nbeta\n",
    rewritten: false,
  },
  { what: "a fence", source: FENCE, rewritten: false },
  { what: "frontmatter", source: FRONTMATTER, rewritten: false },
  {
    what: "a code span across two lines",
    source: "`a  \nb`\n",
    rewritten: false,
  },
  { what: "an empty document", source: "", rewritten: false },
];

const linesOf = (source: string) => source.split("\n");

describe("canonicalForDiff", () => {
  /**
   * A rule that swallowed or invented a newline would shift every range below
   * it by the same amount, and the ranges would still look like ranges. The
   * two assertions have to ride together: on a line-count mismatch the
   * function hands back the source, so the count on its own can never fail.
   */
  it.each(SAMPLES)("keeps the lines of $what", ({ source, rewritten }) => {
    const canonical = canonicalForDiff(source);
    expect(linesOf(canonical)).toHaveLength(linesOf(source).length);
    expect(canonical !== source).toBe(rewritten);
  });

  it("leaves a fence's contents byte for byte", () => {
    const lines = linesOf(canonicalForDiff(FENCE));
    expect(lines[3]).toBe("3. foo");
    expect(lines[4]).toBe("4. bar");
  });

  it("leaves the prefix in front of a quoted table", () => {
    const lines = linesOf(canonicalForDiff(QUOTED_TABLE)).filter(
      (line) => line !== "",
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.startsWith("> ")).toBe(true);
  });

  // Without `remark-frontmatter` in the parser this line reads as an ordered
  // list, and the canonical text carries a list token where the document has
  // a title.
  it("leaves a frontmatter value that opens with a number", () => {
    expect(canonicalForDiff(FRONTMATTER)).toContain("title: 1. x");
  });
});
