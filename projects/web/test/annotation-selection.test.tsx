import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { IssueListItem } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/** Render, select `pick`'s range, and return the floating comment button. */
async function stageSelection(
  body: string,
  pick: (container: HTMLElement) => {
    node: Node;
    from: number;
    to: number;
    /** Defaults to `node`; give one to select across two blocks. */
    endNode?: Node;
  },
  options: { client?: QueryClient; ready?: string } = {},
) {
  const onStage = vi.fn();
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={body}
      annotations={[]}
      onStage={onStage}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
    options.client,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (!el.querySelector(options.ready ?? "[data-loc]")) {
      throw new Error("not rendered");
    }
    return el;
  });
  const { node, from, to, endNode } = pick(container);
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(endNode ?? node, to);
  const selection = window.getSelection();
  if (!selection) throw new Error("no selection support");
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(container);
  const button = await view.findByText(/Comment L/);
  return { view, container, onStage, button };
}

// T-60: the spec annotation flow died in two places — the comment button's
// appearance re-rendered the markdown with a fresh component-override map
// (React remounts overridden elements, killing the text selection anchored
// in them), and the button's own mouseup bubbled into the container handler,
// unmounting it before click could fire.

describe("MarkdownView DOM stability (T-60 root cause A)", () => {
  it("keeps overridden elements' DOM nodes across re-renders", async () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    // MarkdownView reads the reference config through react-query now, so
    // a provider is part of its contract (the app root always has one).
    const client = testQueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MarkdownView slug="p" issueNumber={1}>
          {md}
        </MarkdownView>
      </QueryClientProvider>,
    );
    const before = view.container.querySelector("p");
    expect(before).not.toBeNull();
    // Same props, new parent render — overridden <p> must not remount.
    view.rerender(
      <QueryClientProvider client={client}>
        <MarkdownView slug="p" issueNumber={1}>
          {md}
        </MarkdownView>
      </QueryClientProvider>,
    );
    const after = view.container.querySelector("p");
    expect(after).toBe(before);
  });
});

describe("AnnotatedMarkdown floating button (T-60 root cause B)", () => {
  function selectParagraph(container: HTMLElement): void {
    const p = container.querySelector("p[data-loc]");
    if (!p?.firstChild) throw new Error("no stamped paragraph to select");
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom selection unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
  }

  it("survives its own press and stages even after the selection collapses", async () => {
    const onStage = vi.fn();
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n\nDelta epsilon."}
        annotations={[]}
        onStage={onStage}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });

    selectParagraph(container);
    fireEvent.mouseUp(container);
    const button = await view.findByText(/Comment L1/);

    // The real browser clears the selection on the button's mousedown
    // (prevented in production by preventDefault, but jsdom runs no such
    // default anyway); what must hold is that the button's own mouse
    // events never re-enter the container handler and unmount it.
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseDown(button);
    fireEvent.mouseUp(button);
    expect(view.queryByText(/Comment L1/)).not.toBeNull();

    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: null,
      colEnd: null,
    });
  });

  it("still clears the button on a genuine collapsed-selection mouseup", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma."}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });

    selectParagraph(container);
    fireEvent.mouseUp(container);
    await view.findByText(/Comment L1/);

    // A click elsewhere in the document collapses the selection; the
    // mouseup originates on markdown content, so the button must go.
    window.getSelection()?.removeAllRanges();
    fireEvent.mouseUp(container.querySelector("p[data-loc]") as Element);
    await waitFor(() => {
      expect(view.queryByText(/Comment L1/)).toBeNull();
    });
  });
});

// T-142: a selection that stops inside a line anchors to the columns it
// actually covers, instead of claiming the whole block.
describe("AnnotatedMarkdown column anchors (T-142)", () => {
  it("anchors to the selected columns inside a paragraph", async () => {
    const { onStage, button } = await stageSelection(
      "The quick brown fox jumps.\n",
      (container) => {
        const node = container.querySelector("p[data-loc]")?.firstChild;
        if (!node) throw new Error("no paragraph");
        return { node, from: 4, to: 9 };
      },
    );
    expect(button.textContent).toContain("L1:5–9");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 5,
      colEnd: 9,
    });
  });

  it("anchors inside one table cell, on that row's source line", async () => {
    const { onStage, button } = await stageSelection(
      "| a | b |\n| --- | --- |\n| one | two |\n",
      (container) => {
        const cells = container.querySelectorAll("tbody td");
        const node = cells[1]?.firstChild;
        if (!node) throw new Error("no second cell");
        return { node, from: 0, to: 3 };
      },
    );
    fireEvent.click(button);
    // "| one | two |" — the word "two" occupies columns 9 through 11.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 3,
      lineEnd: 3,
      colStart: 9,
      colEnd: 11,
    });
  });

  it("spans the whole line when the selection does", async () => {
    const { onStage, button } = await stageSelection(
      "intro\n\nsecond paragraph here\n",
      (container) => {
        const node =
          container.querySelectorAll("p[data-loc]")[1]?.firstChild ?? null;
        if (!node) throw new Error("no second paragraph");
        return { node, from: 0, to: "second paragraph here".length };
      },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 3,
      lineEnd: 3,
      colStart: 1,
      colEnd: 21,
    });
  });

  it("falls back to lines for a selection anchored on an element", async () => {
    const onStage = vi.fn();
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma.\n"}
        annotations={[]}
        onStage={onStage}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const p = container.querySelector("p[data-loc]");
    if (!p) throw new Error("no paragraph");
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(container);
    fireEvent.click(await view.findByText(/Comment L1/));
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: null,
      colEnd: null,
    });
  });
});

// T-169: an endpoint left sitting on a line's newline used to anchor at
// column len+1, which the server rejects — the inclusive contract has no
// way to say "one past the end".
describe("AnnotatedMarkdown line-end columns (T-169)", () => {
  // A soft break keeps both lines in one paragraph, so a single text node
  // holds the newline an endpoint can land on. Line 1 is 4 characters.
  const SOFT_WRAP = "甲乙丙,\n丁戊己。\n";

  function paragraphText(container: HTMLElement): Node {
    const node = container.querySelector("p[data-loc]")?.firstChild;
    if (!node) throw new Error("no paragraph");
    return node;
  }

  const inParagraph = (from: number, to: number) => (c: HTMLElement) => ({
    node: paragraphText(c),
    from,
    to,
  });

  it("moves a start at the end of a line to column 1 of the next", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(4, 7),
    );
    expect(button.textContent).toContain("L2:1–2");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 1,
      colEnd: 2,
    });
  });

  it("moves an end past the line's newline back onto its last character", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(0, 5),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 4,
    });
  });

  it("falls back to whole lines when the selection is only a newline", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(4, 5),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 2,
      colStart: null,
      colEnd: null,
    });
  });

  it("anchors one character to one column at both ends", async () => {
    const { onStage, button } = await stageSelection(
      SOFT_WRAP,
      inParagraph(0, 1),
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: 1,
      colEnd: 1,
    });
  });

  it("never puts a column on a blank line the selection spans", async () => {
    const { onStage, button } = await stageSelection(
      "one\n\nthree\n",
      (container) => {
        const paragraphs = container.querySelectorAll("p[data-loc]");
        const start = paragraphs[0]?.firstChild;
        const end = paragraphs[1]?.firstChild;
        if (!start || !end) throw new Error("no paragraphs");
        return { node: start, from: 0, to: 5, endNode: end };
      },
    );
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 3,
      colStart: 1,
      colEnd: 5,
    });
  });

  it("offers no anchor at all for a collapsed selection", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={SOFT_WRAP}
        annotations={[]}
        onStage={() => {}}
        onEditDraft={() => {}}
        onRemoveDraft={() => {}}
        onResolve={() => {}}
      />,
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("p[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const node = container.querySelector("p[data-loc]")?.firstChild;
    if (!node) throw new Error("no paragraph");
    const range = document.createRange();
    range.setStart(node, 3);
    range.setEnd(node, 3);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(container);
    await waitFor(() => {
      expect(view.queryByText(/Comment L/)).toBeNull();
    });
  });
});

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
});

// Reverse mapping (selection → source line and column) block kind by block
// kind. What matters per kind is whether it may carry columns at all: the
// ones that can must be exact, and the ones that cannot must widen to the
// whole line rather than name a column they cannot prove.
describe("AnnotatedMarkdown reverse mapping by block kind", () => {
  it("anchors inside one list item, on that item's source line", async () => {
    const { onStage, button } = await stageSelection(
      "- alpha one\n- beta two\n",
      (container) => {
        const node = container.querySelectorAll("li[data-loc]")[1]?.firstChild;
        if (!node) throw new Error("no second item");
        return { node, from: 0, to: 4 };
      },
    );
    fireEvent.click(button);
    // "- beta two" — the word "beta" occupies columns 3 through 6.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 2,
      lineEnd: 2,
      colStart: 3,
      colEnd: 6,
    });
  });

  it("widens to the quoted prose inside a blockquote", async () => {
    const { onStage, button } = await stageSelection(
      "> first line\n> second line\n",
      (container) => {
        const node = container.querySelector("blockquote p")?.firstChild;
        if (!node) throw new Error("no quoted paragraph");
        return { node, from: 11, to: 17 };
      },
    );
    fireEvent.click(button);
    // The "> " prefixes make the source span longer than the text it
    // renders, so the segment cannot be entered and the anchor grows to
    // its edges: in-bounds on both lines, and containing the selection.
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 2,
      colStart: 3,
      colEnd: 13,
    });
  });

  it("gives up columns on a line holding a ref chip", async () => {
    const client = testQueryClient();
    client.setQueryData(
      issueRefQuery("p", 12).queryKey,
      refItem(12, "A referenced issue"),
    );
    const { container, onStage, button } = await stageSelection(
      "see #12 here\n",
      (c) => {
        const node = c.querySelector("p[data-loc]")?.firstChild;
        if (!node) throw new Error("no paragraph");
        return { node, from: 0, to: 3 };
      },
      { client, ready: "a[data-issue-link]" },
    );
    // The chip renders the issue's title where the source says "#12", so
    // rendered offsets no longer line up with source ones at all.
    expect(container.textContent).toContain("A referenced issue");
    fireEvent.click(button);
    expect(onStage).toHaveBeenCalledWith({
      lineStart: 1,
      lineEnd: 1,
      colStart: null,
      colEnd: null,
    });
  });
});
