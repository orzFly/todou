import { QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
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
    expect(marker?.getAttribute("title")).toContain("第二段。");
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
