import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

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
  async function stageSelection(
    body: string,
    pick: (container: HTMLElement) => { node: Node; from: number; to: number },
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
    );
    const container = await waitFor(() => {
      const el = view.getByTestId("annotated-markdown");
      if (!el.querySelector("[data-loc]")) throw new Error("not rendered");
      return el;
    });
    const { node, from, to } = pick(container);
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = window.getSelection();
    if (!selection) throw new Error("no selection support");
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(container);
    const button = await view.findByText(/Comment L/);
    return { view, container, onStage, button };
  }

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
