import type { Element, Root, RootContent } from "hast";
import { describe, expect, it } from "vitest";
import {
  type Fold,
  type FoldBlock,
  foldKey,
  planFolds,
  rehypeFoldUnchanged,
} from "../src/lib/rehype-fold-unchanged.ts";

type Mark = "changed" | "annotated" | "heading";

/** `count` blocks of one source line each, two lines apart. */
function blockList(
  count: number,
  marks: Record<number, Mark[]> = {},
): FoldBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    lines: { start: i * 2 + 1, end: i * 2 + 1 },
    changed: marks[i]?.includes("changed") ?? false,
    annotated: marks[i]?.includes("annotated") ?? false,
    heading: marks[i]?.includes("heading") ?? false,
  }));
}

const CASES: Array<{
  name: string;
  blocks: FoldBlock[];
  keepHeading: boolean;
  folds: Fold[];
}> = [
  {
    name: "three changes spread across 30 blocks",
    blocks: blockList(30, { 4: ["changed"], 14: ["changed"], 24: ["changed"] }),
    keepHeading: false,
    folds: [
      { from: 1, to: 2 },
      { from: 6, to: 12 },
      { from: 16, to: 22 },
      { from: 26, to: 28 },
    ],
  },
  {
    name: "the same, with the section headings kept",
    blocks: blockList(30, {
      2: ["heading"],
      4: ["changed"],
      12: ["heading"],
      14: ["changed"],
      24: ["changed"],
    }),
    keepHeading: true,
    // Keeping block 2 leaves a one-block run below the first block, and
    // keeping 12 shortens the second fold; the heading above 24 is 12 again.
    folds: [
      { from: 6, to: 11 },
      { from: 16, to: 22 },
      { from: 26, to: 28 },
    ],
  },
  {
    name: "neighbouring changes leave no run between them",
    blocks: blockList(8, { 3: ["changed"], 4: ["changed"] }),
    keepHeading: true,
    folds: [],
  },
  {
    name: "an annotated block is kept and breaks the run",
    blocks: blockList(12, { 5: ["annotated"] }),
    keepHeading: true,
    folds: [
      { from: 1, to: 4 },
      { from: 6, to: 10 },
    ],
  },
  {
    name: "nothing marked folds everything between the ends",
    blocks: blockList(6),
    keepHeading: true,
    folds: [{ from: 1, to: 4 }],
  },
  {
    name: "no blocks at all",
    blocks: [],
    keepHeading: true,
    folds: [],
  },
  {
    name: "a document of two blocks has nothing to fold",
    blocks: blockList(2),
    keepHeading: true,
    folds: [],
  },
];

describe("planFolds", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      expect(
        planFolds(testCase.blocks, {
          minRun: 2,
          keepHeading: testCase.keepHeading,
        }),
      ).toEqual(testCase.folds);
    });
  }

  it("leaves a single unchanged block open", () => {
    // 32px of placeholder for one block's worth of height, at the price of a
    // click: the threshold is what makes folding worth the interaction.
    const blocks = blockList(5, { 1: ["changed"], 3: ["changed"] });
    expect(planFolds(blocks, { minRun: 2, keepHeading: true })).toEqual([]);
  });
});

describe("foldKey", () => {
  it("spans the source lines of the hidden blocks", () => {
    const blocks = blockList(10, { 4: ["changed"] });
    expect(foldKey({ from: 1, to: 2 }, blocks)).toBe("3-5");
  });

  it("reads through a block with no position", () => {
    const blocks = blockList(5);
    const middle = blocks[2];
    if (middle === undefined) throw new Error("fixture");
    blocks[2] = { ...middle, lines: null };
    expect(foldKey({ from: 1, to: 3 }, blocks)).toBe("3-7");
  });

  it("falls back to indices when nothing carries a position", () => {
    const blocks = blockList(3).map((block) => ({ ...block, lines: null }));
    expect(foldKey({ from: 0, to: 1 }, blocks)).toBe("i0-1");
  });
});

/** Paragraph `n`, occupying source line `2n - 1`. */
function paragraph(n: number, className?: string[]): Element {
  const line = n * 2 - 1;
  return {
    type: "element",
    tagName: "p",
    properties: className === undefined ? {} : { className },
    children: [{ type: "text", value: `段落 ${n}` }],
    position: { start: { line, column: 1 }, end: { line, column: 2 } },
  };
}

/** What rehype-decorations splices in for a structural removal. */
function deletionMarker(): Element {
  return {
    type: "element",
    tagName: "del",
    properties: { className: ["spec-del-block"] },
    children: [{ type: "text", value: "删掉的一段。" }],
  };
}

const shape = (tree: Root): string[] =>
  tree.children.map((child: RootContent) => {
    if (child.type !== "element") return child.type;
    const className = child.properties.className;
    const classes = Array.isArray(className) ? className.join(".") : "";
    return classes === "" ? child.tagName : `${child.tagName}.${classes}`;
  });

/** Every placeholder in document order, as `[fold key, its text]`. */
function placeholders(tree: Root): Array<[unknown, string]> {
  return tree.children.flatMap((child) => {
    if (child.type !== "element" || child.tagName !== "button") return [];
    const text = child.children
      .map((node) => (node.type === "text" ? node.value : ""))
      .join("");
    return [[child.properties["data-fold-key"], text] as [unknown, string]];
  });
}

describe("rehypeFoldUnchanged", () => {
  it("keeps every painted block, its neighbours and the document's ends", () => {
    const tree: Root = {
      type: "root",
      children: [
        paragraph(1),
        paragraph(2),
        paragraph(3),
        deletionMarker(),
        paragraph(4),
        paragraph(5),
        paragraph(6, ["spec-ins-block"]),
        paragraph(7),
        paragraph(8),
      ],
    };
    rehypeFoldUnchanged({
      changedRanges: [{ start: 15, end: 15 }],
      annotationRanges: [],
      expanded: new Set(),
      keepHeading: true,
    })(tree);
    // The marker has no source position; its decoration class is what marks
    // it changed, and paragraphs 3 and 4 are its context.
    expect(shape(tree)).toEqual([
      "p",
      "p",
      "p",
      "del.spec-del-block",
      "p",
      "p",
      "p.spec-ins-block",
      "p",
      "p",
    ]);
  });

  it("folds a run behind one placeholder", () => {
    const tree: Root = {
      type: "root",
      children: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => paragraph(n)),
    };
    rehypeFoldUnchanged({
      changedRanges: [{ start: 9, end: 9 }],
      annotationRanges: [],
      expanded: new Set(),
      keepHeading: true,
    })(tree);
    expect(shape(tree)).toEqual([
      "p",
      "button.spec-fold",
      "p.spec-folded",
      "p.spec-folded",
      "p",
      "p",
      "p",
      "p",
      "p",
    ]);
    expect(placeholders(tree)).toEqual([["3-5", "2 unchanged blocks"]]);
    const button = tree.children[1];
    if (button?.type !== "element") throw new Error("no placeholder");
    expect(button.properties.type).toBe("button");
    expect(button.properties["aria-label"]).toBe("Show 2 unchanged blocks");
  });

  it("leaves an opened fold alone", () => {
    const tree: Root = {
      type: "root",
      children: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => paragraph(n)),
    };
    rehypeFoldUnchanged({
      changedRanges: [{ start: 9, end: 9 }],
      annotationRanges: [],
      expanded: new Set(["3-5"]),
      keepHeading: true,
    })(tree);
    expect(shape(tree)).toEqual(["p", "p", "p", "p", "p", "p", "p", "p"]);
  });

  it("keeps a block an annotation is anchored in", () => {
    const tree: Root = {
      type: "root",
      children: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => paragraph(n)),
    };
    rehypeFoldUnchanged({
      changedRanges: [{ start: 15, end: 15 }],
      annotationRanges: [{ start: 5, end: 5 }],
      expanded: new Set(),
      keepHeading: true,
    })(tree);
    // Paragraph 3 carries the chip, and it splits the middle in two: one run
    // of a single block above it, one long enough to fold below.
    expect(shape(tree)).toEqual([
      "p",
      "p",
      "p",
      "button.spec-fold",
      "p.spec-folded",
      "p.spec-folded",
      "p.spec-folded",
      "p",
      "p",
    ]);
    expect(placeholders(tree)).toEqual([["7-11", "3 unchanged blocks"]]);
  });

  it("marks each fold with the lines it hides", () => {
    const tree: Root = {
      type: "root",
      children: Array.from({ length: 12 }, (_, i) => paragraph(i + 1)),
    };
    rehypeFoldUnchanged({
      changedRanges: [{ start: 11, end: 11 }],
      annotationRanges: [],
      expanded: new Set(),
      keepHeading: true,
    })(tree);
    // Paragraph 6 changed, so 5 and 7 stay: two folds, lines 3–7 and 15–21.
    expect(placeholders(tree)).toEqual([
      ["3-7", "3 unchanged blocks"],
      ["15-21", "4 unchanged blocks"],
    ]);
  });
});
