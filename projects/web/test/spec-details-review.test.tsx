import { waitFor } from "@testing-library/react";
import type { SpecCommentItem } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
  visibleAnchor,
} from "../src/components/spec/annotated-markdown.tsx";
import { openEnclosingFolds, revealBlock } from "../src/lib/scroll-insets.ts";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders } from "./render.tsx";

// Same pin as the other rendered-view suites: fences go through pierre.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: () => null,
  MultiFileDiff: () => null,
}));

const FOLD_BODY = "折叠里的原文说明。";

/** A document whose 11th block is a fold; `body` rewrites what it holds. */
function doc(body = FOLD_BODY): string {
  const before = Array.from(
    { length: 10 },
    (_, i) => `段落 ${i + 1} 的原文说明。`,
  );
  const after = Array.from(
    { length: 10 },
    (_, i) => `段落 ${i + 11} 的原文说明。`,
  );
  return `${[
    ...before,
    `<details>\n<summary>细节</summary>\n\n${body}\n\n</details>`,
    ...after,
  ].join("\n\n")}\n`;
}

/** The fold's own opening line: ten blocks of two lines each, then `<details>`. */
const FOLD_LINE = 10 * 2 + 1;
/** The fold's body, three lines further down (summary, blank, body). */
const BODY_LINE = FOLD_LINE + 3;

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
    created_at: "2026-09-17T00:00:00Z",
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

function annotation(
  line: number,
  { colStart = null, colEnd = null }: Partial<DisplayedAnnotation> = {},
): DisplayedAnnotation {
  return {
    key: `c${line}`,
    kind: "comment",
    item: comment(line, { line_start: line, line_end: line }),
    start: line,
    end: line,
    colStart,
    colEnd,
  };
}

async function renderSpec({
  body,
  baselineBody,
  annotations = [],
  foldUnchanged = false,
}: {
  body: string;
  baselineBody?: string;
  annotations?: DisplayedAnnotation[];
  foldUnchanged?: boolean;
}) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={body}
      baselineBody={baselineBody}
      annotations={annotations}
      changedRanges={
        baselineBody === undefined
          ? undefined
          : changedLineRanges(baselineBody, body)
      }
      foldUnchanged={foldUnchanged}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (el.querySelector("details") === null) {
      throw new Error("not rendered yet");
    }
    return el;
  });
  return { view, container };
}

describe("a fold in the spec review view", () => {
  it("opens when its body changed since the baseline", async () => {
    const { container } = await renderSpec({
      baselineBody: doc(),
      body: doc("折叠里的改写说明。"),
    });
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("opens for a change only the decorations can see", async () => {
    // A line diff reports added lines and nothing else, so a deletion inside
    // the fold leaves `changedRanges` with nothing to intersect — the mark
    // the word diff paints is the only evidence there is.
    const baselineBody = doc("第一句留下。\n第二句被删。");
    const body = doc("第一句留下。");
    const ranges = changedLineRanges(baselineBody, body);
    expect(ranges.filter((r) => r.end >= FOLD_LINE)).toEqual([]);
    const { container } = await renderSpec({ baselineBody, body });
    const details = container.querySelector("details");
    expect(details?.querySelector(".spec-del")).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(true);
  });

  it("opens when a column-anchored annotation lands inside it", async () => {
    const { container } = await renderSpec({
      body: doc(),
      annotations: [annotation(BODY_LINE, { colStart: 1, colEnd: 3 })],
    });
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("opens for a whole-line annotation, which decorates nothing", async () => {
    // A line anchor produces no decoration span at all, so this document
    // reaches the renderer with neither decorations nor folding switched on.
    const { container } = await renderSpec({
      body: doc(),
      annotations: [annotation(FOLD_LINE)],
    });
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("stays shut with nothing of interest inside it", async () => {
    const { container } = await renderSpec({
      body: doc(),
      annotations: [annotation(1)],
    });
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(
      false,
    );
  });

  it("is not folded away by the unchanged-block pass", async () => {
    const { container } = await renderSpec({
      baselineBody: doc(),
      body: doc("折叠里的改写说明。"),
      foldUnchanged: true,
    });
    const details = container.querySelector("details");
    expect(details?.hasAttribute("open")).toBe(true);
    expect(details?.classList.contains("spec-folded")).toBe(false);
    // The pass did run, or the assertion above says nothing about it.
    expect(
      container.querySelectorAll("button.spec-fold").length,
    ).toBeGreaterThan(0);
  });
});

/** A live DOM to walk, built the way the browser would hand one over. */
function host(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("visibleAnchor", () => {
  it("returns the element itself when no fold encloses it", () => {
    const root = host("<p id='t'>x</p>");
    const target = root.querySelector<HTMLElement>("#t");
    expect(visibleAnchor(target as HTMLElement)).toBe(target);
  });

  it("returns the shut fold holding it", () => {
    const root = host("<details id='d'><p id='t'>x</p></details>");
    expect(
      visibleAnchor(root.querySelector<HTMLElement>("#t") as HTMLElement),
    ).toBe(root.querySelector("#d"));
  });

  it("returns the element itself when the fold is open", () => {
    const root = host("<details open><p id='t'>x</p></details>");
    const target = root.querySelector<HTMLElement>("#t");
    expect(visibleAnchor(target as HTMLElement)).toBe(target);
  });

  it("climbs past a nested fold to the outermost shut one", () => {
    const root = host(
      "<details id='outer'><details id='inner'><p id='t'>x</p></details></details>",
    );
    expect(
      visibleAnchor(root.querySelector<HTMLElement>("#t") as HTMLElement),
    ).toBe(root.querySelector("#outer"));
  });

  // The walk starts at the parent, not at the element: `closest` on a shut
  // fold answers with that fold, and the loop would never leave it.
  it("returns a shut fold that stands on its own", () => {
    const root = host("<details id='t'><p>x</p></details>");
    const target = root.querySelector<HTMLElement>("#t");
    expect(visibleAnchor(target as HTMLElement)).toBe(target);
  });
});

describe("openEnclosingFolds", () => {
  it("opens the fold holding the target", () => {
    const root = host("<details id='d'><p id='t'>x</p></details>");
    openEnclosingFolds(root.querySelector("#t") as Element);
    expect(root.querySelector("#d")?.hasAttribute("open")).toBe(true);
  });

  it("opens both levels of a nested fold", () => {
    const root = host(
      "<details id='outer'><details id='inner'><p id='t'>x</p></details></details>",
    );
    openEnclosingFolds(root.querySelector("#t") as Element);
    expect(root.querySelector("#outer")?.hasAttribute("open")).toBe(true);
    expect(root.querySelector("#inner")?.hasAttribute("open")).toBe(true);
  });

  it("leaves an already open fold and its neighbours alone", () => {
    const root = host(
      "<details id='open' open><p id='t'>x</p></details><details id='other'></details>",
    );
    openEnclosingFolds(root.querySelector("#t") as Element);
    expect(root.querySelector("#open")?.hasAttribute("open")).toBe(true);
    expect(root.querySelector("#other")?.hasAttribute("open")).toBe(false);
  });

  it("is what revealBlock does before it measures", () => {
    const seen: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      seen.push(this);
    } as typeof Element.prototype.scrollIntoView;
    try {
      const root = host("<details id='d'><p id='t'>x</p></details>");
      revealBlock(root.querySelector<HTMLElement>("#t") as HTMLElement, {
        flash: false,
      });
      expect(root.querySelector("#d")?.hasAttribute("open")).toBe(true);
      expect(seen).toEqual([root.querySelector("#t")]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
