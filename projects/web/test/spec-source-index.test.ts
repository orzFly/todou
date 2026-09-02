import { describe, expect, it } from "vitest";
import { changeDecorations } from "../src/lib/spec-decorations.ts";
import {
  blocksWhollyInGroups,
  buildSegmentIndex,
  lineColAt,
  offsetAt,
  outermostBlockOfGroup,
  segmentsInLines,
  sourceOffsetOfRendered,
  sourceOffsetOfText,
  sourceRangesOfText,
} from "../src/lib/spec-source-index.ts";
import { wordDiff } from "../src/lib/word-diff.ts";

/** What the rendered view highlights, straight off the engine. */
function insertedText(oldBody: string, newBody: string): string[] {
  const decorations = changeDecorations(
    buildSegmentIndex(oldBody),
    buildSegmentIndex(newBody),
  );
  return decorations.spans
    .filter((span) => span.kind === "ins")
    .map((span) => newBody.slice(span.start, span.end));
}

/** The counterpart: the text struck through inside the block that replaced it. */
function deletedText(oldBody: string, newBody: string): string[] {
  const decorations = changeDecorations(
    buildSegmentIndex(oldBody),
    buildSegmentIndex(newBody),
  );
  return decorations.deletions
    .filter((deletion) => !deletion.block)
    .map((deletion) => deletion.text);
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

  it("records the leaf block each group came from", () => {
    expect(index.groupTypes).toEqual([
      "heading",
      "paragraph",
      "tableCell",
      "tableCell",
      "tableCell",
      "tableCell",
      "code",
      "paragraph",
    ]);
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

  it("gives a fence one group of its own, and no opacity (T-211)", () => {
    const code = index.blocks.find((b) => b.type === "code");
    // 标题 段落 and the table's four cells are groups 0…5.
    expect([code?.firstGroup, code?.lastGroup]).toEqual([6, 6]);
    expect(code?.opaque).toBe(false);
  });

  it("propagates opacity from raw HTML up to every ancestor", () => {
    const nested = buildSegmentIndex("> 引言段落。\n>\n> <b>x</b>\n");
    const quote = nested.blocks.find((b) => b.type === "blockquote");
    const paragraph = nested.blocks.find((b) => b.type === "paragraph");
    expect(quote?.opaque).toBe(true);
    // The first paragraph is the prose one; the tag lives in the second.
    expect(paragraph?.opaque).toBe(false);
  });

  it("no longer calls a quote opaque for holding a fence (T-211)", () => {
    const nested = buildSegmentIndex(
      "> 引言段落。\n>\n> ```js\n> code();\n> ```\n",
    );
    expect(nested.blocks.map((b) => [b.type, b.opaque])).toEqual([
      ["blockquote", false],
      ["paragraph", false],
      ["code", false],
    ]);
  });

  describe("alignment evidence (T-163)", () => {
    it("walks up to the largest block built only of unmatched groups", () => {
      // 甲 乙 一 二 are groups 2…5; the heading and paragraph are 0 and 1.
      const found = blocksWhollyInGroups(index, new Set([2, 3, 4, 5]));
      expect(found.map((b) => b.type)).toEqual(["table"]);
    });

    it("drops to the row when only that row's cells are unmatched", () => {
      const found = blocksWhollyInGroups(index, new Set([4, 5]));
      expect(found.map((b) => b.type)).toEqual(["tableRow"]);
      expect(found[0]?.line).toBe(7);
    });

    it("stops at the cell when its neighbour in the row was matched", () => {
      const found = blocksWhollyInGroups(index, new Set([4]));
      expect(found.map((b) => b.type)).toEqual(["tableCell"]);
    });

    it("finds nothing when no block is unmatched throughout", () => {
      expect(blocksWhollyInGroups(index, new Set())).toEqual([]);
    });

    it("lets a group with no prose abstain instead of veto", () => {
      const doc = buildSegmentIndex("| 甲 |  |\n| --- | --- |\n| 一 | 二 |\n");
      // Group 1 is the empty header cell — it has no prose to be new.
      const found = blocksWhollyInGroups(doc, new Set([0, 2, 3]));
      expect(found.map((b) => b.type)).toEqual(["table"]);
    });

    it("refuses a block whose fence nothing accounted for", () => {
      const doc = buildSegmentIndex("> 引言。\n>\n> ```js\n> a();\n> ```\n");
      // Group 0 is the paragraph, group 1 the fence. Half the quote is not
      // the quote — the fence has to be unmatched too.
      const found = blocksWhollyInGroups(doc, new Set([0]));
      expect(found.map((b) => b.type)).not.toContain("blockquote");
      const both = blocksWhollyInGroups(doc, new Set([0, 1]));
      expect(both.map((b) => b.type)).toEqual(["blockquote"]);
    });
  });

  describe("outermostBlockOfGroup", () => {
    it("climbs from a cell to the table that holds it", () => {
      const block = outermostBlockOfGroup(index, 5);
      expect(block?.type).toBe("table");
    });

    it("stops at a top-level leaf, which is its own outermost", () => {
      expect(outermostBlockOfGroup(index, 1)?.type).toBe("paragraph");
    });

    it("has no answer for a group no block owns", () => {
      expect(outermostBlockOfGroup(index, 99)).toBeNull();
    });
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
