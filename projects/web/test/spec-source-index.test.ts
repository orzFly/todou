import { describe, expect, it } from "vitest";
import { changeDecorations } from "../src/lib/spec-decorations.ts";
import {
  blocksWhollyInGroups,
  buildSegmentIndex,
  lineColAt,
  offsetAt,
  outermostBlockOfGroup,
  partsText,
  segmentsInLines,
  sourceOffsetOfRendered,
  sourceOffsetOfText,
  sourceRangesOfText,
  type TableMatrix,
  tableOf,
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

describe("tableOf (T-221)", () => {
  const TABLE3 = [
    "## 矩阵",
    "",
    "| 名称 | 渠道 | 判定 |",
    "| --- | --- | --- |",
    "| 行证据 | 纯新增 | A |",
    "| 覆盖证据 | 重写 | B |",
    "| 第三行 | 会被删掉 | C |",
    "",
  ].join("\n");

  /** The matrix of the first table in a document. */
  function matrixOf(source: string) {
    const index = buildSegmentIndex(source);
    const at = index.blocks.findIndex((b) => b.type === "table");
    return { index, matrix: tableOf(index, at) };
  }

  const cellTexts = (matrix: TableMatrix | null) =>
    matrix?.rows.map((row) => row.cells.map((cell) => cell?.text ?? null));

  it("rebuilds a three-column table as four rows of three", () => {
    const { index, matrix } = matrixOf(TABLE3);
    expect(cellTexts(matrix)).toEqual([
      ["名称", "渠道", "判定"],
      ["行证据", "纯新增", "A"],
      ["覆盖证据", "重写", "B"],
      ["第三行", "会被删掉", "C"],
    ]);
    for (const row of matrix?.rows ?? []) {
      for (const cell of row.cells) {
        if (cell === null) continue;
        expect(index.text.slice(cell.at, cell.at + cell.text.length)).toBe(
          cell.text,
        );
      }
    }
  });

  it("gives an empty cell a group but no text to sit in", () => {
    const { matrix } = matrixOf("| 名称 |  |\n| --- | --- |\n| 行证据 | A |\n");
    const empty = matrix?.rows[0]?.cells[1];
    expect(empty?.text).toBe("");
    expect(empty?.at).toBe(-1);
    expect(empty?.group).toBeGreaterThanOrEqual(0);
  });

  it("squares a ragged table off against its header", () => {
    const { matrix } = matrixOf(
      "| a | b |\n| --- | --- |\n| 1 | 2 | extra |\n| 3 |\n",
    );
    // What the page shows: `extra` is never rendered, and the short row gets a
    // padding `<td>` with no source position of its own.
    expect(cellTexts(matrix)).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", null],
    ]);
  });

  it("rebuilds a table nested in a list item", () => {
    const { matrix } = matrixOf(
      "- 说明：\n\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |\n",
    );
    expect(cellTexts(matrix)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("has no answer for a block that is not a table", () => {
    const index = buildSegmentIndex("段落。\n");
    expect(tableOf(index, 0)).toBeNull();
    expect(tableOf(index, 99)).toBeNull();
  });

  describe("what each cell shows, images included (T-229)", () => {
    const secondCell = (source: string) =>
      matrixOf(source).matrix?.rows[1]?.cells[1];

    it("gives a cell holding nothing but an image one image part", () => {
      const cell = secondCell(
        "| 名 | 图 |\n| --- | --- |\n| a | ![截图](/a.png) |\n",
      );
      expect(cell?.parts).toEqual([
        { kind: "image", url: "/a.png", alt: "截图" },
      ]);
      // The prose view stays what T-221 built it to be: an image is not text,
      // so the cell still reads as empty to the row × column alignment.
      expect(cell?.text).toBe("");
    });

    it("keeps an image and the words beside it in source order", () => {
      const cell = secondCell(
        "| 名 | 证据 |\n| --- | --- |\n| a | ![](/a.png) 旧形态 |\n",
      );
      expect(cell?.parts).toEqual([
        { kind: "image", url: "/a.png", alt: "" },
        { kind: "text", text: "旧形态" },
      ]);
      // The flattened text keeps the space the image left behind; the part is
      // rendered on its own, so it does not.
      expect(cell?.text).toBe(" 旧形态");
    });

    it("keeps two images in one cell in source order", () => {
      const cell = secondCell(
        "| 名 | 图 |\n| --- | --- |\n| a | ![](/a.png)![](/b.png) |\n",
      );
      expect(cell?.parts).toEqual([
        { kind: "image", url: "/a.png", alt: "" },
        { kind: "image", url: "/b.png", alt: "" },
      ]);
    });

    it("finds an image wrapped in a link", () => {
      const cell = secondCell(
        "| 名 | 图 |\n| --- | --- |\n| a | [![](/a.png)](/x) |\n",
      );
      expect(cell?.parts).toEqual([{ kind: "image", url: "/a.png", alt: "" }]);
    });

    it("says exactly what `text` says when no image is involved", () => {
      // The equivalence every T-221 assertion rests on: `parts` is a second
      // view of the same cell, not a different reading of it.
      const { matrix } = matrixOf(TABLE3);
      for (const row of matrix?.rows ?? []) {
        for (const cell of row.cells) {
          if (cell === null) continue;
          expect(cell.parts).toEqual([{ kind: "text", text: cell.text }]);
        }
      }
      const { matrix: ragged } = matrixOf(
        "| 名 |  |\n| --- | --- |\n| a | b |\n",
      );
      expect(ragged?.rows[0]?.cells[1]?.parts).toEqual([]);
    });

    it("reads an image-free cell back as exactly its `text`", () => {
      // The identity the whole of T-230 rests on: once the alignment pairs by
      // `partsText` instead of `text`, this is the entire reason a table with
      // no image in it goes on aligning byte for byte the way it did.
      const { matrix } = matrixOf(TABLE3);
      for (const row of matrix?.rows ?? []) {
        for (const cell of row.cells) {
          if (cell === null) continue;
          expect(partsText(cell.parts)).toBe(cell.text);
        }
      }
      expect(partsText([])).toBe("");
    });

    it("reads a cell's image back as its markdown", () => {
      expect(
        partsText(
          secondCell("| 名 | 图 |\n| --- | --- |\n| a | ![截图](/a.png) |\n")
            ?.parts ?? [],
        ),
      ).toBe("![截图](/a.png)");
    });

    it("reads an image and the words beside it in source order", () => {
      expect(
        partsText(
          secondCell(
            "| 名 | 证据 |\n| --- | --- |\n| a | ![](/a.png) 旧形态 |\n",
          )?.parts ?? [],
        ),
      ).toBe("![](/a.png)旧形态");
    });
  });
});

describe("image leaves (T-223)", () => {
  it("gives an image a leaf group and a source range of its own", () => {
    const index = buildSegmentIndex("![alt](/a.png)\n");
    expect(index.groupTypes).toEqual(["paragraph", "image"]);
    const block = index.blocks.find((b) => b.type === "image");
    expect(index.source.slice(block?.start ?? -1, block?.end ?? -1)).toBe(
      "![alt](/a.png)",
    );
    expect(index.images.get(1)).toEqual({
      url: "/a.png",
      alt: "alt",
      title: null,
      start: block?.start,
      end: block?.end,
    });
  });

  it("keeps the title and the empty alt the source actually has", () => {
    expect(
      buildSegmentIndex('![a](/a.png "标题")\n').images.get(1)?.title,
    ).toBe("标题");
    expect(buildSegmentIndex("![](/a.png)\n").images.get(1)?.alt).toBe("");
  });

  it("leaves an image reference alone", () => {
    // Resolving `![alt][ref]` means reading the definition table, which is a
    // different job; until then it stays as invisible as it always was.
    const index = buildSegmentIndex("![alt][ref]\n\n[ref]: /a.png\n");
    expect(index.groupTypes).not.toContain("image");
    expect(index.images.size).toBe(0);
  });

  it("leaves the flattened text and every segment offset untouched", () => {
    // The regression the whole card turns on: an image contributes no prose,
    // so annotation anchors and selection mapping read a paragraph holding one
    // exactly as they did before images became leaves.
    const index = buildSegmentIndex("看这张 ![](/a.png) 就懂了。\n");
    expect(index.text).toBe("看这张  就懂了。");
    expect(index.segments.map((s) => [s.text, s.at, s.start, s.end])).toEqual([
      ["看这张 ", 0, 0, 4],
      [" 就懂了。", 4, 15, 20],
    ]);
  });

  it("lets a paragraph holding only an image be judged whole", () => {
    const index = buildSegmentIndex("![](/a.png)\n");
    expect(
      blocksWhollyInGroups(index, new Set([1])).map((b) => b.type),
    ).toEqual(["paragraph"]);
    expect(blocksWhollyInGroups(index, new Set())).toEqual([]);
  });

  it("does not let an image speak for a paragraph that has prose too", () => {
    const index = buildSegmentIndex("看这张 ![](/a.png) 就懂了。\n");
    // The image qualifies on its own — that is how an image added inline gets
    // the highlight put on the `<img>` — but the paragraph around it does not.
    expect(
      blocksWhollyInGroups(index, new Set([1])).map((b) => b.type),
    ).toEqual(["image"]);
  });

  it("keeps an image in a table cell inside that cell's groups", () => {
    const index = buildSegmentIndex(
      "| 名 | 图 |\n| --- | --- |\n| a | ![](/a.png) |\n",
    );
    const image = [...index.images.keys()][0] ?? -1;
    const cell = index.blocks.find(
      (b) =>
        b.type === "tableCell" && b.firstGroup <= image && b.lastGroup >= image,
    );
    expect(cell).toBeDefined();
    // The cell still reads as empty to the row × column alignment (T-221):
    // an image is not prose, and folding it in would be T-229's question.
    const table = index.blocks.findIndex((b) => b.type === "table");
    expect(tableOf(index, table)?.rows[1]?.cells[1]?.text).toBe("");
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

describe("frontmatter in the index", () => {
  const source =
    "---\ntitle: Design\nstatus: approved\n---\n\n# Heading\n\nBody text.\n";

  it("indexes the block, its fields and its cells the way a table is", () => {
    const index = buildSegmentIndex(source);
    const at = index.blocks.findIndex((b) => b.type === "frontmatter");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = index.blocks[at];
    // Top level, and covering both fences: that is the range a wholly-new
    // block is highlighted over and a removed one is quoted from.
    expect(block?.parent).toBeNull();
    expect(source.slice(block?.start, block?.end)).toBe(
      "---\ntitle: Design\nstatus: approved\n---",
    );
    const rows = index.blocks.filter(
      (b) => b.type === "tableRow" && b.parent === at,
    );
    expect(rows).toHaveLength(2);
    // `frontmatterBody` pushes no block, which is what makes a field row's
    // parent the frontmatter block itself — the relation `tableOf` reads.
    for (const row of rows) {
      const rowAt = index.blocks.indexOf(row);
      expect(
        index.blocks.filter(
          (b) => b.type === "tableCell" && b.parent === rowAt,
        ),
      ).toHaveLength(2);
    }
  });

  it("keeps every cell's segment an exact slice of the source", () => {
    // The invariant the whole decoration chain rests on: a word-level mark is
    // mapped back onto the source by adding an offset, which is only sound
    // while the text and its span agree character for character.
    const index = buildSegmentIndex(
      "---\ntitle: Design\nmeta:\n  nested: 1\n---\n\nBody.\n",
    );
    const groups = new Set(
      index.blocks
        .filter((b) => b.type === "tableCell")
        .map((cell) => cell.firstGroup),
    );
    const inCells = index.segments.filter((s) => groups.has(s.group));
    expect(inCells).toHaveLength(4);
    for (const segment of inCells) {
      expect(segment.exact).toBe(true);
      expect(index.source.slice(segment.start, segment.end)).toBe(segment.text);
    }
    // The indented continuation included, which `mdast-util-to-hast` would
    // have trimmed on its own way to the DOM.
    expect(inCells.map((s) => s.text)).toContain("\n  nested: 1");
  });

  it("reads the block as a two-column matrix, one row per field", () => {
    const index = buildSegmentIndex(source);
    const at = index.blocks.findIndex((b) => b.type === "frontmatter");
    const matrix = tableOf(index, at);
    expect(
      matrix?.rows.map((row) => row.cells.map((cell) => cell?.text ?? null)),
    ).toEqual([
      ["title", "Design"],
      ["status", "approved"],
    ]);
  });

  it("stays two columns wide when the first field has no key", () => {
    // The width comes from row 0, so a keyless field leading the block must
    // not narrow the matrix and drop every value out of the diff.
    const index = buildSegmentIndex('+++\n[owner]\nname = "bot-one"\n+++\n');
    const at = index.blocks.findIndex((b) => b.type === "frontmatter");
    expect(
      tableOf(index, at)?.rows.map((row) =>
        row.cells.map((cell) => cell?.text ?? null),
      ),
    ).toEqual([
      ["", "[owner]"],
      ["name", '"bot-one"'],
    ]);
  });

  it("leaves a document without frontmatter exactly as it was", () => {
    const index = buildSegmentIndex("# Heading\n\nBody text.\n");
    expect(index.blocks.some((b) => b.type === "frontmatter")).toBe(false);
    expect(index.text).toBe("Heading\nBody text.");
  });
});
