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
 * T-209's repro: a paragraph is deleted and the heading beneath it renumbered,
 * which the line diff hands over as one 1×1 rewrite pair — paragraph against
 * heading — plus a bare deletion of the old heading.
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
  it("refuses to inline-diff a deleted paragraph against an unrelated heading", async () => {
    const { container } = await renderDiff(T209_BEFORE, T209_AFTER);
    // The pair used to hang all 72 characters off `5.6 CLI` as one `<del>`.
    expect(container.querySelector("del.spec-del")).toBeNull();
    expect(container.querySelector("ins.spec-ins")).toBeNull();
    expect(container.querySelector("h3.spec-ins-block")?.textContent).toBe(
      "5.6 CLI",
    );
    expect(texts(container, "del.spec-del-block")).toEqual([
      T209_PARA,
      "### 5.5 CLI",
    ]);
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

  it("shows a removed table row whole", async () => {
    const { container } = await renderDiff(
      T209_TABLE_BEFORE,
      T209_TABLE_BEFORE.replace(`${T209_TABLE_ROWS[4]}\n`, ""),
    );
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toBe(T209_TABLE_ROWS[4]);
    // The row it stands for was the table's last, so the marker settles
    // after the table rather than inside it.
    expect(marker?.previousElementSibling?.tagName).toBe("TABLE");
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
