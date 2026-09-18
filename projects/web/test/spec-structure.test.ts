import { describe, expect, it } from "vitest";
import { buildSegmentIndex } from "../src/lib/spec-source-index.ts";
import {
  planStructuralDeletions,
  predecessorPriorityOrder,
  type StructuralAlignmentPair,
} from "../src/lib/spec-structure.ts";

/** Pair indices name the numbered leaf groups in each literal fixture. */
function plan(
  oldSource: string,
  newSource: string,
  pairs: StructuralAlignmentPair[],
  gone: number[],
) {
  return planStructuralDeletions(
    buildSegmentIndex(oldSource),
    buildSegmentIndex(newSource),
    pairs,
    new Set(gone),
  );
}

const triples = (
  oldSource: string,
  newSource: string,
  pairs: StructuralAlignmentPair[],
  gone: number[],
) => {
  const result = plan(oldSource, newSource, pairs, gone);
  return {
    planned: result.planned.map((record) => ({
      text: record.fallback.text,
      parent: record.parent?.index ?? null,
      after: record.after?.index ?? null,
      order: record.order,
      at: record.fallback.at,
    })),
    unplanned: result.unplanned.map((block) =>
      oldSource.slice(block.start, block.end),
    ),
  };
};

describe("predecessorPriorityOrder", () => {
  it("puts consecutive removals after their predecessor and before a new peer", () => {
    expect(
      predecessorPriorityOrder(
        4,
        0,
        [
          [0, 0],
          [3, 3],
        ],
        [
          [1, "B"],
          [2, "C"],
        ],
      ),
    ).toEqual([
      { kept: 0 },
      { gone: "B" },
      { gone: "C" },
      { kept: 1 },
      { kept: 2 },
      { kept: 3 },
    ]);
  });

  it("honors a fixed leading header and leading and trailing removals", () => {
    expect(
      predecessorPriorityOrder(
        3,
        1,
        [[2, 1]],
        [
          [1, "first"],
          [3, "last"],
        ],
      ),
    ).toEqual([
      { kept: 0 },
      { gone: "first" },
      { kept: 1 },
      { gone: "last" },
      { kept: 2 },
    ]);
  });
});

describe("planStructuralDeletions", () => {
  it("finds first, middle, and last sibling slots", () => {
    expect(
      triples(
        "A\n\nB\n\nC",
        "B\n\nC",
        [
          [1, 0],
          [2, 1],
        ],
        [0],
      ),
    ).toEqual({
      planned: [{ text: "A", parent: null, after: null, order: 0, at: 0 }],
      unplanned: [],
    });
    expect(
      triples(
        "A\n\nB\n\nC",
        "A\n\nC",
        [
          [0, 0],
          [2, 1],
        ],
        [1],
      ),
    ).toEqual({
      planned: [{ text: "B", parent: null, after: 0, order: 1, at: 1 }],
      unplanned: [],
    });
    expect(
      triples(
        "A\n\nB\n\nC",
        "A\n\nB",
        [
          [0, 0],
          [1, 1],
        ],
        [2],
      ),
    ).toEqual({
      planned: [{ text: "C", parent: null, after: 1, order: 2, at: 4 }],
      unplanned: [],
    });
  });

  it("retains baseline order for consecutive removals and all removals", () => {
    expect(
      triples(
        "A\n\nB\n\nC\n\nD",
        "A\n\nD",
        [
          [0, 0],
          [3, 1],
        ],
        [1, 2],
      ),
    ).toEqual({
      planned: [
        { text: "B", parent: null, after: 0, order: 1, at: 1 },
        { text: "C", parent: null, after: 0, order: 2, at: 1 },
      ],
      unplanned: [],
    });
    expect(triples("A\n\nB", "", [], [0, 1])).toEqual({
      planned: [
        { text: "A", parent: null, after: null, order: 0, at: 0 },
        { text: "B", parent: null, after: null, order: 1, at: 0 },
      ],
      unplanned: [],
    });
  });

  it("prioritizes a retained predecessor when an addition shares its slot", () => {
    expect(
      triples(
        "A\n\nB\n\nC",
        "A\n\nNEW\n\nC",
        [
          [0, 0],
          [2, 2],
        ],
        [1],
      ),
    ).toEqual({
      planned: [{ text: "B", parent: null, after: 0, order: 1, at: 1 }],
      unplanned: [],
    });
  });

  it("plans a whole deleted parent once, not also each deleted child", () => {
    expect(triples("- A\n- B\n\nend", "end", [[2, 0]], [0, 1])).toEqual({
      planned: [
        { text: "- A\n- B", parent: null, after: null, order: 0, at: 0 },
      ],
      unplanned: [],
    });
  });

  it("keeps a deleted item within its uniquely mapped list", () => {
    expect(
      triples(
        "- A\n- B\n- C",
        "- A\n- C",
        [
          [0, 0],
          [2, 1],
        ],
        [1],
      ),
    ).toEqual({
      planned: [{ text: "- B", parent: 0, after: 1, order: 1, at: 3 }],
      unplanned: [],
    });
  });

  it("does not cross adjacent lookalike lists", () => {
    expect(
      triples(
        "- same\n\nbridge\n\n- same\n- lost",
        "- same\n\nbridge\n\n- same",
        [
          [0, 2],
          [1, 1],
          [2, 0],
        ],
        [3],
      ),
    ).toEqual({ planned: [], unplanned: ["- lost"] });
  });

  it("leaves a container with conflicting leaf votes unplanned", () => {
    expect(
      triples(
        "- A\n- B\n- lost",
        "- A\n\nseparator\n\n- B",
        [
          [0, 0],
          [1, 2],
        ],
        [2],
      ),
    ).toEqual({ planned: [], unplanned: ["- lost"] });
  });

  it("accepts Alignment with unchanged anchors missing from explicit pairs", () => {
    const oldIndex = buildSegmentIndex("- A\n- B\n- C");
    const newIndex = buildSegmentIndex("- A\n- C");
    const result = planStructuralDeletions(
      oldIndex,
      newIndex,
      {
        pairs: [],
        oldOnly: [
          {
            group: { group: 1, type: "paragraph", text: "B", at: 2 },
            newIndex: 1,
          },
        ],
        newOnly: [],
      },
      new Set([1]),
    );
    expect(
      result.planned.map((record) => ({
        text: record.fallback.text,
        parent: record.parent?.index ?? null,
        after: record.after?.index ?? null,
        order: record.order,
      })),
    ).toEqual([{ text: "- B", parent: 0, after: 1, order: 1 }]);
    expect(result.unplanned).toEqual([]);
  });
});
