import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { renderWithProviders } from "./render.tsx";

// #60: the spec annotation flow died in two places — the comment button's
// appearance re-rendered the markdown with a fresh component-override map
// (React remounts overridden elements, killing the text selection anchored
// in them), and the button's own mouseup bubbled into the container handler,
// unmounting it before click could fire.

describe("MarkdownView DOM stability (#60 root cause A)", () => {
  it("keeps overridden elements' DOM nodes across re-renders", async () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    const view = render(
      <MarkdownView slug="p" issueNumber={1}>
        {md}
      </MarkdownView>,
    );
    const before = view.container.querySelector("p");
    expect(before).not.toBeNull();
    // Same props, new parent render — overridden <p> must not remount.
    view.rerender(
      <MarkdownView slug="p" issueNumber={1}>
        {md}
      </MarkdownView>,
    );
    const after = view.container.querySelector("p");
    expect(after).toBe(before);
  });
});

describe("AnnotatedMarkdown floating button (#60 root cause B)", () => {
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
    expect(onStage).toHaveBeenCalledWith({ lineStart: 1, lineEnd: 1 });
  });

  it("still clears the button on a genuine collapsed-selection mouseup", async () => {
    const view = renderWithProviders(
      <AnnotatedMarkdown
        slug="p"
        issueNumber={1}
        body={"Alpha beta gamma."}
        annotations={[]}
        onStage={() => {}}
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
