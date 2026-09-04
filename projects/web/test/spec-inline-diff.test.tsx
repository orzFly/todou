import { QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { changeDecorations } from "../src/lib/spec-decorations.ts";
import { buildSegmentIndex } from "../src/lib/spec-source-index.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// Same pin as spec-review-web: fences go through pierre's lazy CodeView.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

async function renderDiff(
  before: string,
  after: string,
  annotations: DisplayedAnnotation[] = [],
) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={annotations}
      changedRanges={changedLineRanges(before, after)}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (el.querySelector("[data-loc]") === null) {
      throw new Error("not rendered yet");
    }
    return el;
  });
  return { view, container };
}

const texts = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].map((el) => el.textContent);

/** T-163's repro, verbatim from the card: a paragraph replaced by a table. */
const REPRO_BEFORE =
  "## 结论\n\n这一段会被整段删掉，用来看纯删除的 marker 还在不在。\n";
const REPRO_AFTER = [
  "## 结论",
  "",
  "| 引擎 | 渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 行证据 | 纯新增 pair | `blocksFullyInLines` |",
  "| 覆盖证据 | 重写 pair | `blocksFullyCoveredByText` |",
  "",
].join("\n");

describe("word-level diff in the rendered view (T-142)", () => {
  it("marks the edited Chinese word instead of the paragraph", async () => {
    const { container } = await renderDiff(
      "# 设计\n\n这是一个中文段落，需要微调其中的措辞。\n",
      "# 设计\n\n这是一个中文段落，需要调整其中的措辞。\n",
    );
    expect(texts(container, "ins.spec-ins")).toEqual(["调整"]);
    expect(texts(container, "del.spec-del")).toEqual(["微调"]);
    // The block wash still marks the paragraph — it drives the ↑↓ nav.
    expect(container.querySelector("p.spec-changed")).not.toBeNull();
  });

  it("marks the replaced English word", async () => {
    const { container } = await renderDiff(
      "The quick brown fox jumps over the lazy dog.\n",
      "The quick brown cat jumps over the lazy dog.\n",
    );
    expect(texts(container, "ins.spec-ins")).toEqual(["cat"]);
    expect(texts(container, "del.spec-del")).toEqual(["fox"]);
  });

  it("keeps emphasis markers out of the highlight", async () => {
    const { container } = await renderDiff(
      "这是 **强调** 的段落。\n",
      "这是 **重点** 的段落。\n",
    );
    expect(texts(container, "ins.spec-ins")).toEqual(["重点"]);
    expect(container.querySelector("strong .spec-ins")).not.toBeNull();
  });

  it("lights the changed table row, not the whole table", async () => {
    const { container } = await renderDiff(
      "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n| 三 | 四 |\n",
      "| 甲 | 乙 |\n| --- | --- |\n| 一 | 贰 |\n| 三 | 四 |\n",
    );
    const table = container.querySelector("table");
    expect(table?.classList.contains("spec-changed")).toBe(false);
    const changedRows = container.querySelectorAll("tr.spec-changed");
    expect(changedRows).toHaveLength(1);
    expect(changedRows[0]?.textContent).toContain("一");
    expect(texts(container, "ins.spec-ins")).toEqual(["贰"]);
    expect(texts(container, "del.spec-del")).toEqual(["二"]);
  });

  it("shows a marker where a whole paragraph was removed", async () => {
    const { container } = await renderDiff(
      "# 设计\n\n第一段。\n\n第二段。\n",
      "# 设计\n\n第一段。\n",
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe("第二段。");
  });

  it("leaves code fences alone", async () => {
    const { container } = await renderDiff(
      "intro\n\n```ts\nconst a = 1;\n```\n",
      "outro\n\n```ts\nconst a = 2;\n```\n",
    );
    expect(container.querySelector("pre .spec-ins")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("const a = 2;");
    expect(texts(container, "ins.spec-ins")).toEqual(["outro"]);
  });

  it("renders nothing extra without a baseline", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"这是一个中文段落，需要调整其中的措辞。\n"}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (el.querySelector("[data-loc]") === null) throw new Error("waiting");
      return el;
    });
    expect(container.querySelector(".spec-ins")).toBeNull();
    expect(container.querySelector(".spec-del")).toBeNull();
  });

  it("keeps text-node identity across a re-render with decorations on (T-60)", async () => {
    const before = "这是一个中文段落，需要微调其中的措辞。\n";
    const after = "这是一个中文段落，需要调整其中的措辞。\n";
    const annotations: DisplayedAnnotation[] = [];
    const client = testQueryClient();
    const tree = (
      <QueryClientProvider client={client}>
        <AnnotatedMarkdown
          slug="p"
          issueNumber={1}
          body={after}
          baselineBody={before}
          annotations={annotations}
          changedRanges={changedLineRanges(before, after)}
          onStage={() => {}}
          onEditDraft={() => {}}
          onRemoveDraft={() => {}}
          onResolve={() => {}}
        />
      </QueryClientProvider>
    );
    const view = render(tree);
    const paragraph = await waitFor(() => {
      const el = view.container.querySelector("p[data-loc]");
      if (el === null) throw new Error("not rendered yet");
      return el;
    });
    const mark = view.container.querySelector("ins.spec-ins");
    view.rerender(tree);
    expect(view.container.querySelector("p[data-loc]")).toBe(paragraph);
    expect(view.container.querySelector("ins.spec-ins")).toBe(mark);
  });
});

describe("wholly-new blocks get one highlight (T-158)", () => {
  it("marks a brand-new paragraph as a block, with no marks inside", async () => {
    const { container } = await renderDiff(
      "# 设计\n\n第一段。\n",
      "# 设计\n\n第一段。\n\n第二段完全是新的内容。\n",
    );
    const added = container.querySelector("p.spec-ins-block");
    expect(added?.textContent).toBe("第二段完全是新的内容。");
    expect(added?.querySelector("ins.spec-ins")).toBeNull();
    // The 6% "something changed" wash would only sit under the 12% one.
    expect(added?.classList.contains("spec-changed")).toBe(false);
  });

  it("keeps word-level marks for words inserted into a heading", async () => {
    const { container } = await renderDiff(
      "## 5. 引擎矩阵\n",
      "## 5. 引擎与渠道矩阵\n",
    );
    expect(texts(container, "ins.spec-ins")).toEqual(["与渠道"]);
    expect(container.querySelector(".spec-ins-block")).toBeNull();
  });

  it("marks a brand-new table once, not once per cell", async () => {
    const { container } = await renderDiff(
      "## 矩阵\n",
      "## 矩阵\n\n| 引擎 | 渠道 |\n| --- | --- |\n| A | B |\n",
    );
    expect(container.querySelector("table.spec-ins-block")).not.toBeNull();
    expect(container.querySelectorAll("tr.spec-ins-block")).toHaveLength(0);
    expect(container.querySelector("table .spec-ins")).toBeNull();
  });

  it("marks a row added to an existing table, not the table", async () => {
    const { container } = await renderDiff(
      "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n",
      "| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n| 三 | 四 |\n",
    );
    const rows = container.querySelectorAll("tr.spec-ins-block");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("三");
    expect(container.querySelector("table.spec-ins-block")).toBeNull();
    expect(container.querySelector("ins.spec-ins")).toBeNull();
  });

  it("marks a brand-new list once, not once per item", async () => {
    const { container } = await renderDiff(
      "## 要点\n",
      "## 要点\n\n- 甲项\n- 乙项\n",
    );
    expect(container.querySelector("ul.spec-ins-block")).not.toBeNull();
    expect(container.querySelectorAll("li.spec-ins-block")).toHaveLength(0);
    expect(container.querySelector("ul .spec-ins")).toBeNull();
  });

  it("marks an item added to an existing list, not the list", async () => {
    const { container } = await renderDiff(
      "- 甲项\n- 乙项\n",
      "- 甲项\n- 乙项\n- 丙项\n",
    );
    const items = container.querySelectorAll("li.spec-ins-block");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("丙项");
    expect(container.querySelector("ul.spec-ins-block")).toBeNull();
  });

  it("still finds the new block when jsdiff merged it with an edit", async () => {
    // No unchanged line between the two edits, so they arrive as one
    // rewrite pair and the line range proves nothing about either half.
    const { container } = await renderDiff(
      "## 引擎矩阵\n",
      "## 引擎与渠道矩阵\n\n新增的一整段说明文字。\n",
    );
    const added = container.querySelector("p.spec-ins-block");
    expect(added?.textContent).toBe("新增的一整段说明文字。");
    expect(added?.querySelector("ins.spec-ins")).toBeNull();
    expect(texts(container, "h2 ins.spec-ins")).toEqual(["与渠道"]);
  });

  it("degrades a whole paragraph removed inside a rewrite to a marker", async () => {
    const { container } = await renderDiff(
      "段落甲。\n\n段落乙。\n",
      "段落甲改。\n",
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toContain("段落乙");
    expect(texts(container, "del.spec-del")).not.toContain("段落乙。");
    // Nothing new follows it, so it settles after the block that stayed —
    // which is where the paragraph it stands for used to be.
    expect(marker?.previousElementSibling?.textContent).toBe("段落甲改。");
  });

  it("carries the block class across the pre → CodeBlock swap", async () => {
    const { container } = await renderDiff(
      "## 示例\n",
      "## 示例\n\n```ts\nconst a = 1;\n```\n",
    );
    const wrapper = container.querySelector("div[data-loc].spec-ins-block");
    expect(wrapper?.querySelector("pre")).not.toBeNull();
  });

  it("takes the whole table when a paragraph became one (T-163)", async () => {
    const { container } = await renderDiff(REPRO_BEFORE, REPRO_AFTER);
    expect(container.querySelector("table.spec-ins-block")).not.toBeNull();
    // The old paragraph's words used to match into the cells, leaving word
    // boxes behind and striking the paragraph through the header row.
    expect(container.querySelector("table .spec-ins")).toBeNull();
    expect(container.querySelector("table .spec-del")).toBeNull();
    const markers = container.querySelectorAll("del.spec-del-block");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.textContent).toContain("纯删除的 marker");
  });

  it("still paints an annotation anchored inside a wholly-new block", async () => {
    const { container } = await renderDiff(
      "# 设计\n",
      "# 设计\n\n这是新增的一整段。\n",
      [
        {
          key: "c1",
          kind: "comment",
          item: comment(1, { line_start: 3, line_end: 3 }),
          start: 3,
          end: 3,
          colStart: 1,
          colEnd: 2,
        },
      ],
    );
    const added = container.querySelector("p.spec-ins-block");
    expect(added).not.toBeNull();
    expect(added?.querySelector("mark.spec-mark-comment")?.textContent).toBe(
      "这是",
    );
  });
});

describe("what the engine emits for T-163's repro", () => {
  it("has one block deletion, one whole block, and no word marks", () => {
    // The card measured 11 word boxes on T-142 and 4 on T-158, with the same
    // 4 inline `<del>`s throughout. Aligning the two sides first takes all of
    // them: nothing pairs a paragraph with a cell, so nothing is left to mark.
    const decorations = changeDecorations(
      buildSegmentIndex(REPRO_BEFORE),
      buildSegmentIndex(REPRO_AFTER),
    );
    expect(decorations.spans).toEqual([]);
    expect(decorations.deletions).toHaveLength(1);
    expect(decorations.deletions[0]?.block).toBe(true);
    expect(decorations.deletions[0]?.text).toContain("纯删除的 marker");
    expect(decorations.blocks).toHaveLength(1);
    const block = decorations.blocks[0];
    expect(REPRO_AFTER.slice(block?.start ?? 0, block?.end ?? 0)).toBe(
      REPRO_AFTER.trimEnd().split("\n").slice(2).join("\n"),
    );
    // The marker goes at the table's top-level seam, never inside it.
    expect(decorations.deletions[0]?.at).toBe(block?.start);
  });
});

/** T-180's repro, verbatim from the card: one list item rewritten end to end. */
const REWRITE_BEFORE = [
  "## 变更",
  "",
  "- `format.ts` 增加 `displayWidth()`（East Asian Wide/Fullwidth 区间硬编码，不引依赖），`table()` 改用它补齐。CJK 标题的列表从「必错位」变成对齐可读——这是「可读输出」的字面修复。",
  "",
].join("\n");
const REWRITE_AFTER = [
  "## 变更",
  "",
  "- 引入 [`string-width`](https://github.com/sindresorhus/string-width)（sindresorhus，纯 ESM，无 native 依赖），`table()` 的 padding 改按它计宽。CJK 双宽、emoji、零宽符、ANSI 转义都由库处理，比手搓区间表可靠。CJK 标题的列表从「必错位」变成对齐可读——这是「可读输出」的字面修复。",
  "",
].join("\n");

describe("a heavily rewritten line collapses to few coherent chunks (T-180)", () => {
  it("strikes the old line through in two pieces, not eight", async () => {
    const { container } = await renderDiff(REWRITE_BEFORE, REWRITE_AFTER);
    // The card measured eight: `format.ts`→`引入`, `East`→`sindresorhus，纯`
    // and six more pairings that meant nothing.
    expect(texts(container, "del.spec-del")).toEqual([
      "format.ts 增加 displayWidth()（East Asian Wide/Fullwidth 区间硬编码，不引",
      "改用它补齐。CJK",
    ]);
    // The insertion is two spans; the link and its code span cut the first one
    // into neighbouring elements, which reads as one highlight.
    expect(texts(container, "ins.spec-ins").join("")).toBe(
      "引入 string-width（sindresorhus，纯 ESM，无 native 的 padding 改按它计宽。CJK 双宽、emoji、零宽符、ANSI 转义都由库处理，比手搓区间表可靠。CJK ",
    );
  });

  it("leaves the anchors that outweigh the rewrite unmarked", async () => {
    const { container } = await renderDiff(REWRITE_BEFORE, REWRITE_AFTER);
    const marked = texts(container, "ins.spec-ins, del.spec-del").join("");
    // The sentence the edit never touched, and the anchor mid-line that ties
    // with the change beside it and so stands.
    expect(marked).not.toContain("标题的列表从「必错位」");
    expect(marked).not.toContain("依赖）");
    expect(container.querySelector("li.spec-changed")).not.toBeNull();
  });
});

/**
 * T-209's repro: a paragraph is deleted and the heading beneath it renumbered.
 * The line diff used to hand this over as one 1×1 rewrite pair — paragraph
 * against heading — plus a bare deletion of the old heading, because a blank
 * line between them counted as an anchor. Aligning the whole document at once
 * puts both headings in the same run (T-211).
 */
const T209_PARA =
  "上一版把裁决写在评论里，读者要在时间线里翻找才能知道当前版本过没过；这一版把裁决落到卡片头部的固定位置，任何时候打开都能一眼看到，不必回溯历史。";
const T209_BEFORE = [
  "### 5.4 服务端",
  "",
  T209_PARA,
  "",
  "### 5.5 CLI",
  "",
  "CLI 侧只加一个等待命令。",
  "",
].join("\n");
const T209_AFTER = [
  "### 5.4 服务端",
  "",
  "### 5.6 CLI",
  "",
  "CLI 侧只加一个等待命令。",
  "",
].join("\n");

/** A table to take rows out of, and then to take away whole. */
const T209_TABLE_ROWS = [
  "| 引擎 | 渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 行证据 | 纯新增 pair | `blocksFullyInLines` |",
  "| 覆盖证据 | 重写 pair | `blocksFullyCoveredByText` |",
  "| 第三行 | 会被删掉 | 用来看删行 |",
];
const T209_TABLE_BEFORE = [
  "## 矩阵",
  "",
  ...T209_TABLE_ROWS,
  "",
  "后面还有一段话。",
  "",
].join("\n");

describe("removals read as removals (T-209)", () => {
  it("pairs the renumbered heading across the deleted paragraph (T-211)", async () => {
    const { container } = await renderDiff(T209_BEFORE, T209_AFTER);
    // The pair used to hang all 72 characters off `5.6 CLI` as one `<del>`;
    // T-209 then refused the pair outright, which cost the renumbering its
    // word-level diff and put a second marker on the heading that survived.
    expect(texts(container, "h3 del.spec-del")).toEqual(["5.5"]);
    expect(texts(container, "h3 ins.spec-ins")).toEqual(["5.6"]);
    expect(container.querySelector(".spec-ins-block")).toBeNull();
    expect(texts(container, "del.spec-del-block")).toEqual([T209_PARA]);
  });

  it("shows a removed paragraph whole, well past the old 48-character cut", async () => {
    const { container } = await renderDiff(
      `## 结论\n\n${T209_PARA}\n\n留下的一段。\n`,
      "## 结论\n\n留下的一段。\n",
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toBe(T209_PARA);
    expect(marker?.textContent).not.toContain("…");
  });

  it("shows a removed table row in place (T-221)", async () => {
    const { container } = await renderDiff(
      T209_TABLE_BEFORE,
      T209_TABLE_BEFORE.replace(`${T209_TABLE_ROWS[4]}\n`, ""),
    );
    // T-209 quoted the row's source above the table, because a cell that had
    // no counterpart had nowhere else to go. The table is one leaf now, so the
    // row goes back into it, struck through, where it used to be.
    expect(container.querySelector("del.spec-del-block")).toBeNull();
    const removed = container.querySelectorAll("tr.spec-del-row");
    expect(removed).toHaveLength(1);
    expect(texts(container, "tr.spec-del-row td")).toEqual([
      "第三行",
      "会被删掉",
      "用来看删行",
    ]);
    const body = container.querySelector("tbody");
    expect([...(body?.children ?? [])].at(-1)).toBe(removed[0]);
  });

  it("shows every row of a removed table, each on its own line", async () => {
    const { container } = await renderDiff(
      T209_TABLE_BEFORE,
      "## 矩阵\n\n后面还有一段话。\n",
    );
    expect(container.querySelector("table")).toBeNull();
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toBe(T209_TABLE_ROWS.join("\n"));
  });
});

/** T-221's fixtures: one three-column table, edited nine different ways. */
const T221_BEFORE = [
  "## 矩阵",
  "",
  "| 名称 | 渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 行证据 | 纯新增 | A |",
  "| 覆盖证据 | 重写 | B |",
  "| 第三行 | 会被删掉 | C |",
  "",
  "后面还有一段话。",
  "",
].join("\n");
const t221 = (...rows: string[]) =>
  ["## 矩阵", "", ...rows, "", "后面还有一段话。", ""].join("\n");
/** D: the middle column goes. */
const T221_DROP_MIDDLE = t221(
  "| 名称 | 判定 |",
  "| --- | --- |",
  "| 行证据 | A |",
  "| 覆盖证据 | B |",
  "| 第三行 | C |",
);
/** D2: the last column goes. */
const T221_DROP_LAST = t221(
  "| 名称 | 渠道 |",
  "| --- | --- |",
  "| 行证据 | 纯新增 |",
  "| 覆盖证据 | 重写 |",
  "| 第三行 | 会被删掉 |",
);
/** J: a column arrives in the middle. */
const T221_ADD_COLUMN = t221(
  "| 名称 | 渠道 | 备注 | 判定 |",
  "| --- | --- | --- | --- |",
  "| 行证据 | 纯新增 | 甲 | A |",
  "| 覆盖证据 | 重写 | 乙 | B |",
  "| 第三行 | 会被删掉 | 丙 | C |",
);
/** K: two columns change places, and nothing else. */
const T221_SWAP = t221(
  "| 名称 | 判定 | 渠道 |",
  "| --- | --- | --- |",
  "| 行证据 | A | 纯新增 |",
  "| 覆盖证据 | B | 重写 |",
  "| 第三行 | C | 会被删掉 |",
);
/** L: one header is renamed. */
const T221_RENAME = t221(
  "| 名称 | 来源渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 行证据 | 纯新增 | A |",
  "| 覆盖证据 | 重写 | B |",
  "| 第三行 | 会被删掉 | C |",
);
/** M: a row and a column go together. */
const T221_DROP_BOTH = t221(
  "| 名称 | 判定 |",
  "| --- | --- |",
  "| 行证据 | A |",
  "| 第三行 | C |",
);
/** O: one cell is edited while a column goes. */
const T221_EDIT_AND_DROP = t221(
  "| 名称 | 判定 |",
  "| --- | --- |",
  "| 行证据 | A |",
  "| 覆盖证据 | B 改 |",
  "| 第三行 | C |",
);
/** N: two tables with the same header; only the second one loses a column. */
const T221_TWO_TABLES = [
  "## 甲",
  "",
  "| 名称 | 渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 一 | 二 | 三 |",
  "",
  "## 乙",
  "",
  "| 名称 | 渠道 | 判定 |",
  "| --- | --- | --- |",
  "| 四 | 五 | 六 |",
  "",
].join("\n");
const T221_TWO_TABLES_AFTER = T221_TWO_TABLES.replace(
  "| 名称 | 渠道 | 判定 |\n| --- | --- | --- |\n| 四 | 五 | 六 |",
  "| 名称 | 判定 |\n| --- | --- |\n| 四 | 六 |",
);
/** A cell emptied in place; today's engine turns this into a source marker. */
const T221_FILLED = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
const T221_EMPTIED = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |\n";

const decorationsOf = (before: string, after: string) =>
  changeDecorations(buildSegmentIndex(before), buildSegmentIndex(after));

describe("what the engine emits for table edits (T-221)", () => {
  it("turns a dropped column into one overlay, not four markers", () => {
    // The card's measurement: four block deletions stacked above the table,
    // each quoting one cell's source with its leading pipe.
    const decorations = decorationsOf(T221_BEFORE, T221_DROP_MIDDLE);
    expect(decorations.deletions.filter((d) => d.block)).toEqual([]);
    expect(decorations.blocks).toEqual([]);
    expect(decorations.tables).toHaveLength(1);
    expect(decorations.tables[0]?.columns).toEqual([
      { at: 1, cells: ["渠道", "纯新增", "重写", "会被删掉"] },
    ]);
    expect(decorations.tables[0]?.rows).toEqual([]);
    expect(decorations.tables[0]?.emptied).toEqual([]);
  });

  it("puts a dropped last column at the end of the final order", () => {
    const decorations = decorationsOf(T221_BEFORE, T221_DROP_LAST);
    expect(decorations.tables[0]?.columns).toEqual([
      { at: 2, cells: ["判定", "A", "B", "C"] },
    ]);
  });

  it("keeps a new column as four whole cells and no overlay (J)", () => {
    const decorations = decorationsOf(T221_BEFORE, T221_ADD_COLUMN);
    expect(
      decorations.blocks.map((r) => T221_ADD_COLUMN.slice(r.start, r.end)),
    ).toEqual(["| 备注 ", "| 甲 ", "| 乙 ", "| 丙 "]);
    expect(decorations.tables).toEqual([]);
  });

  it("draws nothing at all when two columns swap places (K)", () => {
    // Cells were anchors document-wide before this card, which put the
    // swapped ones in different runs where they could never meet again.
    expect(decorationsOf(T221_BEFORE, T221_SWAP)).toEqual({
      spans: [],
      deletions: [],
      blocks: [],
      tables: [],
      images: [],
    });
  });

  it("keeps a renamed header word-level (L)", () => {
    const decorations = decorationsOf(T221_BEFORE, T221_RENAME);
    expect(
      decorations.spans.map((s) => T221_RENAME.slice(s.start, s.end)),
    ).toEqual(["来源"]);
    expect(decorations.deletions).toEqual([]);
    expect(decorations.tables).toEqual([]);
  });

  it("splices a dropped row and a dropped column into one order (M)", () => {
    const decorations = decorationsOf(T221_BEFORE, T221_DROP_BOTH);
    expect(decorations.tables[0]?.columns).toEqual([
      { at: 1, cells: ["渠道", "纯新增", "会被删掉"] },
    ]);
    // The row's own cells run in the final column order, so the struck-out
    // column has a slot in it too.
    expect(decorations.tables[0]?.rows).toEqual([
      { at: 2, cells: ["覆盖证据", "重写", "B"] },
    ]);
    expect(decorations.deletions.filter((d) => d.block)).toEqual([]);
  });

  it("never lets one table's cells answer for another's (N)", () => {
    const decorations = decorationsOf(T221_TWO_TABLES, T221_TWO_TABLES_AFTER);
    expect(decorations.tables).toHaveLength(1);
    expect(decorations.tables[0]?.table.start).toBe(
      T221_TWO_TABLES_AFTER.indexOf("| 名称 | 判定 |"),
    );
    expect(decorations.tables[0]?.columns).toEqual([
      { at: 1, cells: ["渠道", "五"] },
    ]);
  });

  it("edits one cell while a column goes (O)", () => {
    const decorations = decorationsOf(T221_BEFORE, T221_EDIT_AND_DROP);
    expect(
      decorations.spans.map((s) => T221_EDIT_AND_DROP.slice(s.start, s.end)),
    ).toEqual([" 改"]);
    expect(decorations.tables[0]?.columns).toEqual([
      { at: 1, cells: ["渠道", "纯新增", "重写", "会被删掉"] },
    ]);
  });

  it("strikes an emptied cell inside itself, not above the table", () => {
    const decorations = decorationsOf(T221_FILLED, T221_EMPTIED);
    expect(decorations.tables[0]?.emptied).toEqual([
      { row: 2, col: 1, text: "4" },
    ]);
    expect(decorations.deletions).toEqual([]);
  });

  it("still quotes a whole removed table as a marker", () => {
    // Nothing is left on the page to splice a column into, so this stays
    // exactly what T-209 settled: the source, in full, at the seam.
    const decorations = decorationsOf(
      T209_TABLE_BEFORE,
      "## 矩阵\n\n后面还有一段话。\n",
    );
    expect(decorations.tables).toEqual([]);
    expect(decorations.deletions.map((d) => [d.block, d.text])).toEqual([
      [true, T209_TABLE_ROWS.join("\n")],
    ]);
  });
});

/** A table inside a list item: the overlay has to recurse to find it. */
const T221_NESTED_BEFORE = [
  "- 说明：",
  "",
  "  | 名称 | 渠道 | 判定 |",
  "  | --- | --- | --- |",
  "  | 行证据 | 纯新增 | A |",
  "",
].join("\n");
const T221_NESTED_AFTER = [
  "- 说明：",
  "",
  "  | 名称 | 判定 |",
  "  | --- | --- |",
  "  | 行证据 | A |",
  "",
].join("\n");

/** Every `th`/`td` of a row, as elements, so a position can be asserted. */
const cellsOf = (row: Element) =>
  [...row.children].filter((el) => el.tagName === "TH" || el.tagName === "TD");

describe("table cells and rows the new version no longer has (T-221)", () => {
  it("puts a dropped column back where it stood, struck through (D)", async () => {
    const { container } = await renderDiff(T221_BEFORE, T221_DROP_MIDDLE);
    expect(container.querySelector("del.spec-del-block")).toBeNull();
    expect(texts(container, "th.spec-del-cell")).toEqual(["渠道"]);
    expect(texts(container, "td.spec-del-cell")).toEqual([
      "纯新增",
      "重写",
      "会被删掉",
    ]);
    // Second cell of every row, header included — the position the column had.
    for (const row of container.querySelectorAll("tr")) {
      expect(cellsOf(row)[1]?.classList.contains("spec-del-cell")).toBe(true);
    }
    expect(texts(container, ".spec-del-cell del.spec-del")).toEqual([
      "渠道",
      "纯新增",
      "重写",
      "会被删掉",
    ]);
  });

  it("keeps a new column as four green cells (J)", async () => {
    const { container } = await renderDiff(T221_BEFORE, T221_ADD_COLUMN);
    const added = container.querySelectorAll(".spec-ins-block");
    expect(added).toHaveLength(4);
    expect([...added].map((el) => el.tagName)).toEqual([
      "TH",
      "TD",
      "TD",
      "TD",
    ]);
    expect(container.querySelector("del.spec-del-block")).toBeNull();
    expect(container.querySelector(".spec-del-cell")).toBeNull();
  });

  it("draws nothing when two columns swap places (K)", async () => {
    const { container } = await renderDiff(T221_BEFORE, T221_SWAP);
    expect(container.querySelector("ins")).toBeNull();
    expect(container.querySelector("del")).toBeNull();
    expect(container.querySelector(".spec-ins-block")).toBeNull();
  });

  it("splices a dropped row and a dropped column into one table (M)", async () => {
    const { container } = await renderDiff(T221_BEFORE, T221_DROP_BOTH);
    expect(texts(container, "th.spec-del-cell")).toEqual(["渠道"]);
    const removed = container.querySelectorAll("tr.spec-del-row");
    expect(removed).toHaveLength(1);
    expect(texts(container, "tr.spec-del-row td")).toEqual([
      "覆盖证据",
      "重写",
      "B",
    ]);
    // Between the two rows that stayed, which is where it used to sit.
    const body = container.querySelector("tbody");
    expect(body?.children[1]).toBe(removed[0]);
    // The row is coloured as a row; its cells carry no column class.
    for (const cell of removed[0]?.children ?? []) {
      expect(cell.classList.contains("spec-del-cell")).toBe(false);
    }
  });

  it("leaves the untouched twin table alone (N)", async () => {
    const { container } = await renderDiff(
      T221_TWO_TABLES,
      T221_TWO_TABLES_AFTER,
    );
    const tables = container.querySelectorAll("table");
    expect(tables).toHaveLength(2);
    expect(tables[0]?.querySelector(".spec-del-cell")).toBeNull();
    expect(texts(tables[1] as HTMLElement, "th.spec-del-cell")).toEqual([
      "渠道",
    ]);
  });

  it("strikes an emptied cell inside the cell itself", async () => {
    const { container } = await renderDiff(T221_FILLED, T221_EMPTIED);
    expect(container.querySelector("del.spec-del-block")).toBeNull();
    const struck = container.querySelector("td del.spec-del");
    expect(struck?.textContent).toBe("4");
    const row = container.querySelectorAll("tbody tr")[1];
    expect(cellsOf(row as Element)[1]?.contains(struck ?? null)).toBe(true);
  });

  it("finds a table nested in a list item", async () => {
    const { container } = await renderDiff(
      T221_NESTED_BEFORE,
      T221_NESTED_AFTER,
    );
    expect(texts(container, "li th.spec-del-cell")).toEqual(["渠道"]);
    expect(texts(container, "li td.spec-del-cell")).toEqual(["纯新增"]);
  });
});

/** A list item whose second half is a fence — one block the prose cannot see. */
const LIST_ONE = "- 甲项说明。\n";
const LIST_TWO = "- 甲项说明改。\n- 乙项：\n\n  ```ts\n  x();\n  ```\n";

describe("the whole document is one alignment (T-211)", () => {
  it("renumbers two headings past one deleted paragraph", async () => {
    const { container } = await renderDiff(
      `${T209_BEFORE}### 5.6 Web\n\n页面照旧。\n`,
      `${T209_AFTER}### 5.7 Web\n\n页面照旧。\n`,
    );
    // Two runs, two 5.x pairs, and the paragraph is the only thing that went.
    expect(texts(container, "h3 del.spec-del")).toEqual(["5.5", "5.6"]);
    expect(texts(container, "h3 ins.spec-ins")).toEqual(["5.6", "5.7"]);
    expect(texts(container, "del.spec-del-block")).toEqual([T209_PARA]);
  });

  it("pairs a short pointer with the paragraph that replaced it", async () => {
    const { container } = await renderDiff(
      "## 结论\n\n见下表。\n",
      `## 结论\n\n${T209_PARA}\n`,
    );
    // Expanding a pointer into prose shares no word with what it became, and
    // is still one paragraph rewritten. T-209's gate read the length ratio
    // (0.056) and rendered a marker plus a wholly-new block instead.
    expect(texts(container, "del.spec-del")).toEqual(["见下表"]);
    // The full stop both sides end on is an anchor, so the insertion stops
    // just short of it.
    expect(texts(container, "ins.spec-ins").join("")).toBe(
      T209_PARA.slice(0, -1),
    );
    expect(container.querySelector(".spec-ins-block")).toBeNull();
    expect(container.querySelector(".spec-del-block")).toBeNull();
  });

  it("takes a new list item whole, fence included, even when merged with an edit", async () => {
    const { container } = await renderDiff(LIST_ONE, LIST_TWO);
    // No unchanged line between the two edits, so the item arrives in the same
    // run as the edit above it. The fence used to make its item opaque, which
    // left the prose half highlighted and the code half bare.
    const items = container.querySelectorAll("li.spec-ins-block");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("乙项");
    expect(items[0]?.textContent).toContain("x();");
    expect(items[0]?.querySelector(".spec-ins")).toBeNull();
    expect(texts(container, "ins.spec-ins")).toEqual(["改"]);
  });

  it("shows a removed list item whole, fence included", async () => {
    const { container } = await renderDiff(LIST_TWO, LIST_ONE);
    const markers = container.querySelectorAll("del.spec-del-block");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.textContent).toContain("乙项");
    expect(markers[0]?.textContent).toContain("x();");
    // The marker quotes source as plain text; nothing re-renders it, so the
    // fence it carries does not come back as a code block.
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    expect(texts(container, "del.spec-del")).toEqual(["改"]);
  });

  it("leaves an edited fence to the line wash", () => {
    const decorations = changeDecorations(
      buildSegmentIndex("```ts\na = 1;\n```\n"),
      buildSegmentIndex("```ts\na = 2;\n```\n"),
    );
    // A fence is a leaf and pairs with its counterpart, but pierre owns what
    // is inside it (T-31), so the pair is drawn on with nothing at all.
    expect(decorations).toEqual({
      spans: [],
      deletions: [],
      blocks: [],
      tables: [],
      images: [],
    });
  });

  it("emits one marker and one word pair for T-209's repro", () => {
    const before = buildSegmentIndex(T209_BEFORE);
    const after = buildSegmentIndex(T209_AFTER);
    const decorations = changeDecorations(before, after);
    expect(decorations.spans).toHaveLength(1);
    const span = decorations.spans[0];
    expect(T209_AFTER.slice(span?.start ?? 0, span?.end ?? 0)).toBe("5.6");
    expect(decorations.deletions.map((d) => [d.block, d.text])).toEqual([
      [false, "5.5"],
      [true, T209_PARA],
    ]);
    expect(decorations.blocks).toEqual([]);
  });
});

function comment(
  commentId: number,
  anchor: Partial<SpecCommentItem["anchor"]>,
): SpecCommentItem {
  return {
    comment_id: commentId,
    author: {
      id: 1,
      login: "alice",
      display_name: "alice",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    created_at: "2026-08-28T00:00:00Z",
    body: "note",
    anchor: {
      path: "design.md",
      version: 1,
      line_start: null,
      line_end: null,
      col_start: null,
      col_end: null,
      quote: "",
      ...anchor,
    },
    resolved: null,
    outdated: false,
    current_line_start: null,
    current_line_end: null,
  };
}

describe("precise annotation highlights (T-142)", () => {
  const body = "这是一个中文段落，需要调整其中的措辞。\n";

  it("paints the anchored columns and drops the block wash", async () => {
    const { container } = await renderDiff(body, body, [
      {
        key: "c1",
        kind: "comment",
        item: comment(1, { line_start: 1, line_end: 1 }),
        start: 1,
        end: 1,
        colStart: 10,
        colEnd: 13,
      },
    ]);
    expect(texts(container, "mark.spec-mark-comment")).toEqual(["需要调整"]);
    expect(container.querySelector("p.spec-annotated")).toBeNull();
  });

  it("keeps the block wash for an anchor without columns", async () => {
    const { container } = await renderDiff(body, body, [
      {
        key: "c1",
        kind: "comment",
        item: comment(1, { line_start: 1, line_end: 1 }),
        start: 1,
        end: 1,
      },
    ]);
    expect(container.querySelector("mark.spec-mark-comment")).toBeNull();
    expect(container.querySelector("p.spec-annotated")).not.toBeNull();
  });
});

/**
 * T-223's fixtures: the same screenshots, swapped in every context we render.
 * The slug is `renderDiff`'s own, so these take the path a spec document's
 * images really take — through `markdown-view.tsx`'s `img:` override and out
 * of `AttachmentInlineImage`, which is where the decoration classes have to
 * survive for any of this to show.
 */
const IMG_A = "/api/projects/p/attachments/929/download/toolbar-v1.png";
const IMG_B = "/api/projects/p/attachments/1401/download/toolbar-v2.png";
const IMG_C = "/api/projects/p/attachments/930/download/panel-v1.png";
const IMG_D = "/api/projects/p/attachments/1402/download/panel-v2.png";
const imageCell = (url: string) =>
  `| 名 | 图 |\n| --- | --- |\n| a | ![](${url}) |\n`;

const decorationsFor = (before: string, after: string) =>
  changeDecorations(buildSegmentIndex(before), buildSegmentIndex(after));

describe("what the engine emits for image edits (T-223)", () => {
  it("reports one swap and draws nothing else, wherever the image sits", () => {
    const contexts: Array<[string, string, string]> = [
      ["alone in a paragraph", `## 图\n\n![](%s)\n`, ""],
      ["inline in a sentence", `看这张 ![](%s) 就懂了。\n`, ""],
      ["in a table cell", imageCell("%s"), ""],
      ["wrapped in a link", `[![](%s)](%s)\n`, ""],
    ];
    for (const [context, template] of contexts) {
      const after = template.replaceAll("%s", IMG_B);
      const decorations = decorationsFor(
        template.replaceAll("%s", IMG_A),
        after,
      );
      expect(decorations.images, context).toHaveLength(1);
      const swap = decorations.images[0];
      expect(swap?.old?.url, context).toBe(IMG_A);
      expect(after.slice(swap?.at.start ?? -1, swap?.at.end ?? -1)).toBe(
        `![](${IMG_B})`,
      );
      // The table leaf still anchors on its prose and the paragraph on its
      // own words: an image pairs as an image and disturbs neither (T-221).
      expect(
        [
          decorations.spans,
          decorations.deletions,
          decorations.blocks,
          decorations.tables,
        ],
        context,
      ).toEqual([[], [], [], []]);
    }
  });

  it("says nothing about the old image when only the alt moved", () => {
    const decorations = decorationsFor(
      `![改前](${IMG_A})\n`,
      `![改后](${IMG_A})\n`,
    );
    expect(decorations.images).toHaveLength(1);
    expect(decorations.images[0]?.old).toBeNull();
  });

  it("gives an added image the whole-block treatment and no swap", () => {
    const after = `## 图\n\n![](${IMG_B})\n\n正文。\n`;
    const decorations = decorationsFor("## 图\n\n正文。\n", after);
    expect(decorations.images).toEqual([]);
    expect(decorations.spans).toEqual([]);
    expect(decorations.blocks.map((b) => after.slice(b.start, b.end))).toEqual([
      `![](${IMG_B})`,
    ]);
  });

  it("puts a removed image into the marker as an image", () => {
    const decorations = decorationsFor(
      `## 图\n\n![](${IMG_A})\n\n正文。\n`,
      "## 图\n\n正文。\n",
    );
    expect(decorations.deletions).toHaveLength(1);
    expect(decorations.deletions[0]?.block).toBe(true);
    expect(decorations.deletions[0]?.parts).toEqual([
      { kind: "image", url: IMG_A, alt: "" },
    ]);
  });

  it("keeps the prose around a removed image in order", () => {
    const decorations = decorationsFor(
      `## 图\n\n看这张 ![](${IMG_A}) 就懂了。\n\n正文。\n`,
      "## 图\n\n正文。\n",
    );
    expect(decorations.deletions[0]?.parts).toEqual([
      { kind: "text", text: "看这张 " },
      { kind: "image", url: IMG_A, alt: "" },
      { kind: "text", text: " 就懂了。" },
    ]);
  });

  it("leaves a deletion holding no image on its byte-for-byte path", () => {
    // A paragraph replaced by an image: the two never pair, so the paragraph
    // gets the marker it always got — no parts, nothing to render differently.
    const decorations = decorationsFor(
      "这里本来是一段文字说明。\n",
      `![](${IMG_B})\n`,
    );
    expect(decorations.deletions).toHaveLength(1);
    expect(decorations.deletions[0]?.parts).toBeUndefined();
    expect(decorations.blocks).toHaveLength(1);
    expect(decorations.images).toEqual([]);
  });

  it("marks the words and leaves the image alone when only prose moved", () => {
    const after = `看这张 ![](${IMG_A}) 就明白了。\n`;
    const decorations = decorationsFor(
      `看这张 ![](${IMG_A}) 就懂了。\n`,
      after,
    );
    expect(decorations.images).toEqual([]);
    expect(decorations.spans.map((s) => after.slice(s.start, s.end))).toEqual([
      "明白了",
    ]);
    expect(decorations.deletions.map((d) => d.text)).toEqual(["懂了"]);
  });

  it("keeps two images swapped at once from crossing", () => {
    const after = `- 改前 ![](${IMG_B})\n- 改后 ![](${IMG_D})\n`;
    const decorations = decorationsFor(
      `- 改前 ![](${IMG_A})\n- 改后 ![](${IMG_C})\n`,
      after,
    );
    expect(decorations.images.map((i) => i.old?.url)).toEqual([IMG_A, IMG_C]);
    expect(
      decorations.images.map((i) => after.slice(i.at.start, i.at.end)),
    ).toEqual([`![](${IMG_B})`, `![](${IMG_D})`]);
  });

  it("draws nothing at all when an image document did not change", () => {
    const body = `看这张 ![](${IMG_A}) 就懂了。\n`;
    const decorations = decorationsFor(body, body);
    expect([
      decorations.spans,
      decorations.deletions,
      decorations.blocks,
      decorations.tables,
      decorations.images,
    ]).toEqual([[], [], [], [], []]);
  });
});

describe("how image edits render (T-223)", () => {
  it("puts the old image beside the new one, in the same paragraph", async () => {
    const { container } = await renderDiff(
      `## 图\n\n![](${IMG_A})\n`,
      `## 图\n\n![](${IMG_B})\n`,
    );
    const old = container.querySelector("del.spec-del-block.spec-img-del");
    expect(old?.querySelector("img")?.getAttribute("src")).toBe(IMG_A);
    const fresh = old?.nextElementSibling;
    expect(fresh?.tagName).toBe("IMG");
    expect(fresh?.getAttribute("src")).toBe(IMG_B);
    expect([...(fresh?.classList ?? [])]).toEqual(
      expect.arrayContaining(["spec-ins-block", "spec-img-new"]),
    );
    // Both direct children of the `<p>`: `markdown-view.tsx` reads exactly
    // that relationship to decide whether a paragraph carries an embed card.
    expect(old?.parentElement?.tagName).toBe("P");
    expect(fresh?.parentElement).toBe(old?.parentElement);
  });

  it("does not draw the same image twice when only the alt moved", async () => {
    const { container } = await renderDiff(
      `![改前](${IMG_A})\n`,
      `![改后](${IMG_A})\n`,
    );
    expect(container.querySelector(".spec-img-del")).toBeNull();
    const fresh = container.querySelector("img.spec-ins-block");
    expect(fresh?.getAttribute("alt")).toBe("改后");
    expect(fresh?.classList.contains("spec-img-new")).toBe(false);
  });

  it("leaves the sentence around an inline swap untouched", async () => {
    const { container } = await renderDiff(
      `看这张 ![](${IMG_A}) 就懂了。\n`,
      `看这张 ![](${IMG_B}) 就懂了。\n`,
    );
    const paragraph = container.querySelector("p");
    expect(paragraph?.textContent).toBe("看这张  就懂了。");
    expect(
      paragraph
        ?.querySelector("del.spec-img-del")
        ?.nextElementSibling?.getAttribute("src"),
    ).toBe(IMG_B);
    expect(container.querySelector("ins.spec-ins")).toBeNull();
  });

  it("gives an added image the block highlight and no half width", async () => {
    const { container } = await renderDiff(
      "## 图\n\n正文。\n",
      `## 图\n\n![](${IMG_B})\n\n正文。\n`,
    );
    expect(container.querySelector("p.spec-ins-block img")).not.toBeNull();
    expect(container.querySelector(".spec-img-new")).toBeNull();
    expect(container.querySelector(".spec-img-del")).toBeNull();
  });

  it("shows a removed image in the marker rather than its url", async () => {
    const { container } = await renderDiff(
      `## 图\n\n![](${IMG_A})\n\n正文。\n`,
      "## 图\n\n正文。\n",
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toBe("");
    expect(marker?.children).toHaveLength(1);
    expect(marker?.children[0]?.tagName).toBe("IMG");
    expect(marker?.children[0]?.getAttribute("src")).toBe(IMG_A);
  });

  it("keeps a swap inside the table cell it happened in", async () => {
    const { container } = await renderDiff(imageCell(IMG_A), imageCell(IMG_B));
    const cell = container.querySelector("td:nth-child(2)");
    const old = cell?.querySelector("del.spec-img-del");
    expect(old?.querySelector("img")?.getAttribute("src")).toBe(IMG_A);
    expect(old?.nextElementSibling?.getAttribute("src")).toBe(IMG_B);
    // The marker never drifts past the table, which is what anchoring on the
    // `<img>` bought over putting the old image at a top-level seam.
    expect(container.querySelector("table del.spec-img-del")).not.toBeNull();
  });

  it("keeps text and image in order inside a removed paragraph", async () => {
    const { container } = await renderDiff(
      `## 图\n\n看这张 ![](${IMG_A}) 就懂了。\n\n正文。\n`,
      "## 图\n\n正文。\n",
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(
      [...(marker?.childNodes ?? [])].map((node) =>
        node.nodeType === 1 ? (node as Element).tagName : node.textContent,
      ),
    ).toEqual(["看这张 ", "IMG", " 就懂了。"]);
  });

  it("leaves an image-free removal reading byte for byte as before", async () => {
    const { container } = await renderDiff(
      "这里本来是一段文字说明。\n",
      `![](${IMG_B})\n`,
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toBe("这里本来是一段文字说明。");
    expect(marker?.querySelector("img")).toBeNull();
  });
});
