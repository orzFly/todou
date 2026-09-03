import { fireEvent, waitFor } from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders } from "./render.tsx";

// Same pin as the other rendered-view suites: fences go through pierre.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: () => null,
  MultiFileDiff: () => null,
}));

async function renderFold(
  before: string,
  after: string,
  {
    annotations = [],
    foldUnchanged = true,
  }: { annotations?: DisplayedAnnotation[]; foldUnchanged?: boolean } = {},
) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={annotations}
      changedRanges={changedLineRanges(before, after)}
      foldUnchanged={foldUnchanged}
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

/** 30 paragraphs, one source line each; `edits` rewrites the numbered ones. */
function doc(edits: Record<number, string> = {}): string {
  const paragraphs = Array.from(
    { length: 30 },
    (_, i) => edits[i + 1] ?? `段落 ${i + 1} 的原文说明。`,
  );
  return `${paragraphs.join("\n\n")}\n`;
}

const rewritten = (n: number) => `段落 ${n} 的改写说明。`;

const V1 = doc();
const V2 = doc({ 5: rewritten(5), 15: rewritten(15), 25: rewritten(25) });

const placeholders = (container: HTMLElement) =>
  [...container.querySelectorAll("button.spec-fold")].map(
    (el) => el.textContent,
  );

/** Top-level blocks the reader can actually see. */
const shown = (container: HTMLElement) =>
  [...(container.querySelector(".markdown-body")?.children ?? [])].filter(
    (el) => el.tagName !== "BUTTON" && !el.classList.contains("spec-folded"),
  );

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
      version: 2,
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

describe("folding the unchanged blocks of a comparison (T-222)", () => {
  it("leaves the changes, their neighbours and the ends of the document", async () => {
    const { container } = await renderFold(V1, V2);
    expect(placeholders(container)).toEqual([
      "2 unchanged blocks",
      "7 unchanged blocks",
      "7 unchanged blocks",
      "3 unchanged blocks",
    ]);
    expect(container.querySelectorAll(".spec-folded")).toHaveLength(19);
    expect(shown(container)).toHaveLength(11);
    expect(container.querySelectorAll("p.spec-changed")).toHaveLength(3);
  });

  it("keeps the heading of the section a change sits in", async () => {
    const heading = "## 中段小节";
    const before = V1.replace("段落 10 的原文说明。", `${heading}\n\n段落 10`);
    const after = before.replace("段落 12 的原文说明。", rewritten(12));
    const { container } = await renderFold(before, after);
    const h2 = container.querySelector("h2");
    expect(h2?.textContent).toBe("中段小节");
    expect(h2?.classList.contains("spec-folded")).toBe(false);
  });

  it("keeps a commented block open, with its chip", async () => {
    // Paragraph 10 sits in the middle of the 7-block run below the first
    // change; a folded block has nowhere to hang the chip.
    const { container, view } = await renderFold(V1, V2, {
      annotations: [
        {
          key: "c1",
          kind: "comment",
          item: comment(1, { line_start: 19, line_end: 19 }),
          start: 19,
          end: 19,
        },
      ],
    });
    expect(placeholders(container)).toEqual([
      "2 unchanged blocks",
      "3 unchanged blocks",
      "3 unchanged blocks",
      "7 unchanged blocks",
      "3 unchanged blocks",
    ]);
    const commented = [...container.querySelectorAll("p")].find(
      (el) => el.textContent === "段落 10 的原文说明。",
    );
    expect(commented?.classList.contains("spec-folded")).toBe(false);
    expect(commented?.classList.contains("spec-annotated")).toBe(true);
    expect(
      view.getByLabelText(/1 comment/).hasAttribute("data-annotation-ui"),
    ).toBe(true);
  });

  it("keeps a block a draft is staged on open", async () => {
    const { container } = await renderFold(V1, V2, {
      annotations: [
        {
          key: "d1",
          kind: "draft",
          draft: {
            id: "d1",
            anchor: {
              path: "design.md",
              version: 2,
              line_start: 19,
              line_end: 19,
              col_start: null,
              col_end: null,
            },
            quote: "段落 10 的原文说明。",
            body: "staged",
          },
          start: 19,
          end: 19,
        },
      ],
    });
    const drafted = [...container.querySelectorAll("p")].find(
      (el) => el.textContent === "段落 10 的原文说明。",
    );
    expect(drafted?.classList.contains("spec-folded")).toBe(false);
  });

  it("keeps a block a column-level anchor points into open", async () => {
    const { container } = await renderFold(V1, V2, {
      annotations: [
        {
          key: "c2",
          kind: "comment",
          item: comment(2, {
            line_start: 19,
            line_end: 19,
            col_start: 1,
            col_end: 2,
          }),
          start: 19,
          end: 19,
          colStart: 1,
          colEnd: 2,
        },
      ],
    });
    const marked = container.querySelector("mark.spec-mark-comment");
    expect(marked?.textContent).toBe("段落");
    expect(marked?.closest("p")?.classList.contains("spec-folded")).toBe(false);
  });

  it("keeps a structural deletion marker and its neighbours open", async () => {
    // The marker carries no source position at all, so only its decoration
    // class can save it from the fold.
    const after = V1.replace("段落 8 的原文说明。\n\n", "").replace(
      "段落 20 的原文说明。",
      rewritten(20),
    );
    const { container } = await renderFold(V1, after);
    const marker = container.querySelector("del.spec-del-block");
    expect(marker?.textContent).toBe("段落 8 的原文说明。");
    expect(marker?.classList.contains("spec-folded")).toBe(false);
    expect(
      marker?.previousElementSibling?.classList.contains("spec-folded"),
    ).toBe(false);
    expect(marker?.nextElementSibling?.classList.contains("spec-folded")).toBe(
      false,
    );
  });

  it("opens one fold per click and leaves the others alone", async () => {
    const { container } = await renderFold(V1, V2);
    const first = container.querySelector("button.spec-fold");
    if (first === null) throw new Error("no placeholder");
    fireEvent.click(first);
    await waitFor(() =>
      expect(placeholders(container)).toEqual([
        "7 unchanged blocks",
        "7 unchanged blocks",
        "3 unchanged blocks",
      ]),
    );
    expect(container.querySelectorAll(".spec-folded")).toHaveLength(17);
    expect(shown(container)).toHaveLength(13);

    const second = container.querySelector("button.spec-fold");
    if (second === null) throw new Error("no placeholder");
    fireEvent.click(second);
    await waitFor(() =>
      expect(placeholders(container)).toEqual([
        "7 unchanged blocks",
        "3 unchanged blocks",
      ]),
    );
    expect(container.querySelectorAll(".spec-folded")).toHaveLength(10);
  });

  it("keeps the chips through an expansion", async () => {
    // happy-dom lays nothing out, so the tops are all 0 here; what this can
    // hold is that the chip survives the re-render the click causes.
    const { container, view } = await renderFold(V1, V2, {
      annotations: [
        {
          key: "c1",
          kind: "comment",
          item: comment(1, { line_start: 19, line_end: 19 }),
          start: 19,
          end: 19,
        },
      ],
    });
    const first = container.querySelector("button.spec-fold");
    if (first === null) throw new Error("no placeholder");
    fireEvent.click(first);
    await waitFor(() =>
      expect(container.querySelectorAll("button.spec-fold")).toHaveLength(4),
    );
    expect(view.getAllByLabelText(/1 comment/)).toHaveLength(1);
  });

  it("renders every block when folding is off", async () => {
    const { container } = await renderFold(V1, V2, { foldUnchanged: false });
    expect(container.querySelector(".spec-fold")).toBeNull();
    expect(container.querySelector(".spec-folded")).toBeNull();
    expect(shown(container)).toHaveLength(30);
    expect(container.querySelectorAll("p.spec-changed")).toHaveLength(3);
  });
});
