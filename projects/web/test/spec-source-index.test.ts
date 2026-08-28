import { describe, expect, it } from "vitest";
import {
  changedBlockPairs,
  changedLineRanges,
} from "../src/lib/spec-changes.ts";
import {
  blocksFullyCoveredByText,
  blocksFullyInLines,
  buildSegmentIndex,
  coversWholeProseBlock,
  lineColAt,
  offsetAt,
  type SegmentIndex,
  segmentsInLines,
  sourceOffsetOfRendered,
  sourceOffsetOfText,
  sourceRangesOfText,
  subtractRanges,
  textRangeOf,
  textRangesOfBlocks,
} from "../src/lib/spec-source-index.ts";
import { wordDiff } from "../src/lib/word-diff.ts";

/** What the rendered view highlights for one edited line range. */
function insertedText(oldBody: string, newBody: string): string[] {
  const oldIndex = buildSegmentIndex(oldBody);
  const newIndex = buildSegmentIndex(newBody);
  const out: string[] = [];
  for (const pair of changedBlockPairs(oldBody, newBody)) {
    if (pair.old === null || pair.new === null) continue;
    const before = textRangeOf(segmentsInLines(oldIndex, pair.old));
    const after = textRangeOf(segmentsInLines(newIndex, pair.new));
    if (before === null || after === null) continue;
    const result = wordDiff(
      oldIndex.text.slice(before.start, before.end),
      newIndex.text.slice(after.start, after.end),
    );
    for (const range of result.ins) {
      for (const source of sourceRangesOfText(
        newIndex,
        after.start + range.start,
        after.start + range.end,
      )) {
        out.push(newBody.slice(source.start, source.end));
      }
    }
  }
  return out;
}

/** The counterpart: what was removed, read off the old side. */
function deletedText(oldBody: string, newBody: string): string[] {
  const oldIndex = buildSegmentIndex(oldBody);
  const newIndex = buildSegmentIndex(newBody);
  const out: string[] = [];
  for (const pair of changedBlockPairs(oldBody, newBody)) {
    if (pair.old === null || pair.new === null) continue;
    const before = textRangeOf(segmentsInLines(oldIndex, pair.old));
    const after = textRangeOf(segmentsInLines(newIndex, pair.new));
    if (before === null || after === null) continue;
    const result = wordDiff(
      oldIndex.text.slice(before.start, before.end),
      newIndex.text.slice(after.start, after.end),
    );
    for (const gone of result.del) {
      out.push(
        oldIndex.text.slice(before.start + gone.from, before.start + gone.to),
      );
    }
  }
  return out;
}

describe("wordDiff", () => {
  it("finds the one Chinese word that moved", () => {
    const result = wordDiff("需要微调其中的措辞。", "需要调整其中的措辞。");
    expect(
      result.ins.map((r) => "需要调整其中的措辞。".slice(r.start, r.end)),
    ).toEqual(["调整"]);
    expect(
      result.del.map((d) => "需要微调其中的措辞。".slice(d.from, d.to)),
    ).toEqual(["微调"]);
  });

  it("finds the one English word that moved", () => {
    const result = wordDiff(
      "The quick brown fox jumps.",
      "The quick brown cat jumps.",
    );
    expect(
      result.ins.map((r) => "The quick brown cat jumps.".slice(r.start, r.end)),
    ).toEqual(["cat"]);
  });

  it("handles pure insertion, pure deletion and equality", () => {
    expect(wordDiff("", "hello")).toEqual({
      ins: [{ start: 0, end: 5 }],
      del: [],
    });
    expect(wordDiff("hello", "")).toEqual({
      ins: [],
      del: [{ at: 0, from: 0, to: 5 }],
    });
    expect(wordDiff("same", "same")).toEqual({ ins: [], del: [] });
  });

  it("counts an astral emoji as its two code units", () => {
    const before = "表情符号 🌱 在这里。";
    const after = "表情符号 🌵 在这里。";
    const result = wordDiff(before, after);
    expect(result.ins.map((r) => after.slice(r.start, r.end))).toEqual(["🌵"]);
    const range = result.ins[0];
    if (range === undefined) throw new Error("no insertion");
    expect(range.end - range.start).toBe(2);
  });
});

describe("buildSegmentIndex", () => {
  const source = [
    "# 标题",
    "",
    "这是 **强调** 的段落。",
    "",
    "| 甲 | 乙 |",
    "| --- | --- |",
    "| 一 | 二 |",
    "",
    "```js",
    "code();",
    "```",
    "",
    "行内 `code` 与 \\*转义\\* 文本。",
    "",
  ].join("\n");
  const index = buildSegmentIndex(source);

  it("flattens prose only, leaf block by leaf block", () => {
    expect(index.text).toBe(
      "标题\n这是 强调 的段落。\n甲\n乙\n一\n二\n行内 code 与 *转义* 文本。",
    );
  });

  it("keeps emphasis inside one flow but splits table cells", () => {
    const paragraph = index.segments.filter((s) => s.line === 3);
    expect(paragraph.map((s) => s.text)).toEqual([
      "这是 ",
      "强调",
      " 的段落。",
    ]);
    expect(new Set(paragraph.map((s) => s.group)).size).toBe(1);
    const row = index.segments.filter((s) => s.line === 5);
    expect(new Set(row.map((s) => s.group)).size).toBe(2);
  });

  it("marks inline code and escapes inexact", () => {
    const inexact = index.segments.filter((s) => !s.exact).map((s) => s.text);
    expect(inexact).toEqual(["code", " 与 *转义* 文本。"]);
  });

  it("leaves fenced code out entirely", () => {
    expect(index.text).not.toContain("code()");
  });

  it("round-trips exact segments through the source", () => {
    for (const segment of index.segments) {
      if (!segment.exact) continue;
      expect(source.slice(segment.start, segment.end)).toBe(segment.text);
    }
  });

  it("maps a flattened range back onto the source, clipped per segment", () => {
    // "强调" sits inside ** ** — the emphasis markers must stay out.
    const at = index.text.indexOf("强调");
    const ranges = sourceRangesOfText(index, at, at + 2);
    expect(ranges).toHaveLength(1);
    expect(source.slice(ranges[0]?.start ?? 0, ranges[0]?.end ?? 0)).toBe(
      "强调",
    );
  });

  it("locates a whole inexact segment rather than guessing inside it", () => {
    const at = index.text.indexOf("code");
    const ranges = sourceRangesOfText(index, at + 1, at + 2);
    expect(source.slice(ranges[0]?.start ?? 0, ranges[0]?.end ?? 0)).toBe(
      "`code`",
    );
  });

  it("never bridges two table cells with one range", () => {
    const at = index.text.indexOf("甲");
    const ranges = sourceRangesOfText(index, at, at + 3);
    expect(ranges.map((r) => source.slice(r.start, r.end))).toEqual([
      "甲",
      "乙",
    ]);
  });

  it("converts between offsets and line/column", () => {
    const offset = source.indexOf("强调");
    const { line, col } = lineColAt(index, offset);
    expect(line).toBe(3);
    expect(offsetAt(index, line, col)).toBe(offset);
    expect(offsetAt(index, line, 9999)).toBeNull();
  });

  it("maps rendered offsets, which have no separators, onto the source", () => {
    const row = segmentsInLines(index, { start: 5, end: 5 });
    // A table row's textContent is "甲乙": offset 1 is the start of "乙".
    const offset = sourceOffsetOfRendered(row, 1, "start");
    expect(offset).not.toBeNull();
    expect(source.slice(offset ?? 0, (offset ?? 0) + 1)).toBe("乙");
  });

  it("places a caret at a flattened position", () => {
    const at = index.text.indexOf("的段落");
    expect(sourceOffsetOfText(index, at)).toBe(source.indexOf("的段落"));
  });
});

/** The prose range covering everything the index holds. */
function wholeText(index: SegmentIndex): Array<{ start: number; end: number }> {
  return [{ start: 0, end: index.text.length }];
}

describe("the block table (T-158)", () => {
  const source = [
    "# 标题",
    "",
    "段落。",
    "",
    "| 甲 | 乙 |",
    "| --- | --- |",
    "| 一 | 二 |",
    "",
    "```js",
    "code();",
    "```",
    "",
  ].join("\n");
  const index = buildSegmentIndex(source);

  it("records every block in document order, parents first", () => {
    expect(index.blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      "tableRow",
      "tableCell",
      "tableCell",
      "tableRow",
      "tableCell",
      "tableCell",
      "code",
    ]);
  });

  it("locates blocks in the source and links them to their parents", () => {
    const table = index.blocks.find((b) => b.type === "table");
    expect(table?.line).toBe(5);
    expect(table?.endLine).toBe(7);
    expect(source.slice(table?.start ?? 0, table?.end ?? 0)).toContain("| 一 ");
    expect(table?.parent).toBeNull();
    const rows = index.blocks.filter((b) => b.type === "tableRow");
    expect(rows.map((r) => r.parent)).toEqual([2, 2]);
    const cells = index.blocks.filter((b) => b.type === "tableCell");
    expect(cells.map((c) => c.parent)).toEqual([3, 3, 6, 6]);
  });

  it("spans a block's leaf groups from its first to its last", () => {
    const table = index.blocks.find((b) => b.type === "table");
    // 甲 乙 一 二 — groups 0 and 1 belong to the heading and the paragraph.
    expect([table?.firstGroup, table?.lastGroup]).toEqual([2, 5]);
    const rows = index.blocks.filter((b) => b.type === "tableRow");
    expect([rows[0]?.firstGroup, rows[0]?.lastGroup]).toEqual([2, 3]);
    expect([rows[1]?.firstGroup, rows[1]?.lastGroup]).toEqual([4, 5]);
  });

  it("owns no group where there is no prose, and says so", () => {
    const code = index.blocks.find((b) => b.type === "code");
    expect(code?.firstGroup).toBe(-1);
    expect(code?.opaque).toBe(true);
  });

  it("propagates opacity from a fence up to every ancestor", () => {
    const nested = buildSegmentIndex(
      "> 引言段落。\n>\n> ```js\n> code();\n> ```\n",
    );
    const quote = nested.blocks.find((b) => b.type === "blockquote");
    const paragraph = nested.blocks.find((b) => b.type === "paragraph");
    expect(quote?.opaque).toBe(true);
    expect(paragraph?.opaque).toBe(false);
  });

  it("reports a block's prose extent in the flattened text", () => {
    const rows = index.blocks.filter((b) => b.type === "tableRow");
    const ranges = textRangesOfBlocks(index, rows.slice(1));
    expect(ranges).toHaveLength(1);
    const range = ranges[0];
    expect(index.text.slice(range?.start ?? 0, range?.end ?? 0)).toBe("一\n二");
  });

  describe("line evidence", () => {
    it("takes the outermost block that fits inside the lines", () => {
      const found = blocksFullyInLines(index, { start: 4, end: 7 });
      expect(found.map((b) => b.type)).toEqual(["table"]);
    });

    it("drops to the row when the table itself does not fit", () => {
      const found = blocksFullyInLines(index, { start: 7, end: 7 });
      expect(found.map((b) => b.type)).toEqual(["tableRow"]);
    });

    it("finds nothing when no block fits whole", () => {
      const multiline = buildSegmentIndex("第一行\n第二行\n第三行\n");
      expect(blocksFullyInLines(multiline, { start: 2, end: 2 })).toEqual([]);
    });

    it("names a fence, which prose coverage never could", () => {
      const found = blocksFullyInLines(index, { start: 8, end: 11 });
      expect(found.map((b) => b.type)).toEqual(["code"]);
    });
  });

  describe("prose-coverage evidence", () => {
    it("walks up to the largest fully covered block", () => {
      const table = buildSegmentIndex(
        "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n",
      );
      const found = blocksFullyCoveredByText(table, wholeText(table));
      expect(found.map((b) => b.type)).toEqual(["table"]);
    });

    it("ignores a block whose prose is only partly covered", () => {
      const doc = buildSegmentIndex("这是一个中文段落，需要调整其中的措辞。\n");
      const at = doc.text.indexOf("调整");
      expect(
        blocksFullyCoveredByText(doc, [{ start: at, end: at + 2 }]),
      ).toEqual([]);
    });

    it("reads an exactly-covered single group as a rewrite, not a new block", () => {
      // The single-line trap: a one-word paragraph whose word was replaced
      // is covered end to end, and word-level marks are what it wants.
      const doc = buildSegmentIndex("段落。\n");
      expect(blocksFullyCoveredByText(doc, wholeText(doc))).toEqual([]);
    });

    it("takes the block when the insertion spills past its prose", () => {
      const doc = buildSegmentIndex("标题\n\n段落。\n");
      const at = doc.text.indexOf("段落。");
      const found = blocksFullyCoveredByText(doc, [
        { start: at - 1, end: doc.text.length },
      ]);
      expect(found.map((b) => b.type)).toEqual(["paragraph"]);
    });

    it("refuses a block holding content it cannot see", () => {
      const doc = buildSegmentIndex("> 引言。\n>\n> ```js\n> a();\n> ```\n");
      const found = blocksFullyCoveredByText(doc, wholeText(doc));
      expect(found.map((b) => b.type)).not.toContain("blockquote");
    });
  });

  describe("whole-prose-block deletions", () => {
    it("sees a paragraph swallowed whole", () => {
      const doc = buildSegmentIndex("段落甲。\n\n段落乙。\n");
      const at = doc.text.indexOf("段落乙。");
      expect(coversWholeProseBlock(doc, at - 1, doc.text.length)).toBe(true);
      expect(coversWholeProseBlock(doc, at + 1, doc.text.length)).toBe(false);
    });

    it("does not count a table cell — the cell outlives the edit", () => {
      const doc = buildSegmentIndex(
        "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n",
      );
      expect(coversWholeProseBlock(doc, 0, doc.text.length)).toBe(false);
    });
  });
});

describe("subtractRanges", () => {
  it("cuts holes out of a range and keeps both remainders", () => {
    expect(
      subtractRanges([{ start: 0, end: 10 }], [{ start: 3, end: 6 }]),
    ).toEqual([
      { start: 0, end: 3 },
      { start: 6, end: 10 },
    ]);
  });

  it("drops a range the cuts cover entirely", () => {
    expect(
      subtractRanges(
        [{ start: 2, end: 5 }],
        [
          { start: 0, end: 3 },
          { start: 3, end: 9 },
        ],
      ),
    ).toEqual([]);
  });

  it("leaves a range untouched when nothing overlaps", () => {
    expect(
      subtractRanges([{ start: 0, end: 4 }], [{ start: 4, end: 8 }]),
    ).toEqual([{ start: 0, end: 4 }]);
  });
});

describe("changedBlockPairs", () => {
  it("pairs a rewrite's two sides", () => {
    expect(changedBlockPairs("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { old: { start: 2, end: 2 }, new: { start: 2, end: 2 }, at: 2 },
    ]);
  });

  it("leaves the old side null for a pure insertion", () => {
    expect(changedBlockPairs("a\nc\n", "a\nb\nc\n")).toEqual([
      { old: null, new: { start: 2, end: 2 }, at: 2 },
    ]);
  });

  it("points a pure deletion at the line that closed the hole", () => {
    expect(changedBlockPairs("a\nb\nc\n", "a\nc\n")).toEqual([
      { old: { start: 2, end: 2 }, new: null, at: 2 },
    ]);
  });

  it("keeps separate edits separate", () => {
    const pairs = changedBlockPairs("a\nb\nc\nd\n", "A\nb\nc\nD\n");
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.new).toEqual({ start: 1, end: 1 });
    expect(pairs[1]?.new).toEqual({ start: 4, end: 4 });
  });

  it("agrees with changedLineRanges on the new side", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nB2\nc\n";
    const fromPairs = changedBlockPairs(before, after)
      .map((p) => p.new)
      .filter((r) => r !== null);
    expect(fromPairs).toEqual(changedLineRanges(before, after));
  });
});

describe("word-level diff through the index", () => {
  it("marks the edited Chinese word, not the paragraph", () => {
    const before = "# 设计\n\n这是一个中文段落，需要微调其中的措辞。\n";
    const after = "# 设计\n\n这是一个中文段落，需要调整其中的措辞。\n";
    expect(insertedText(before, after)).toEqual(["调整"]);
    expect(deletedText(before, after)).toEqual(["微调"]);
  });

  it("marks the replaced English word inside a sentence", () => {
    const before = "The quick brown fox jumps over the lazy dog.\n";
    const after = "The quick brown cat jumps over the lazy dog.\n";
    expect(insertedText(before, after)).toEqual(["cat"]);
  });

  it("marks one changed table cell, not the whole row", () => {
    const before = "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n";
    const after = "| 甲 | 乙 |\n| --- | --- |\n| 一 | 三 |\n";
    expect(insertedText(before, after)).toEqual(["三"]);
    expect(deletedText(before, after)).toEqual(["二"]);
  });

  it("does not let a bold marker leak into the highlight", () => {
    const before = "这是 **强调** 的段落。\n";
    const after = "这是 **重点** 的段落。\n";
    expect(insertedText(before, after)).toEqual(["重点"]);
  });
});
