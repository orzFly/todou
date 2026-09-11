import { EditorView } from "@codemirror/view";
import { render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../src/components/shared/markdown-editor.tsx";
import {
  cmGetValue,
  cmPlaceholder,
  cmPressKey,
  cmSetValue,
  cmView,
} from "./cm.ts";

describe("MarkdownEditor", () => {
  it("mounts with its initial value and reads back through the ref", () => {
    const ref = createRef<MarkdownEditorHandle>();
    const view = render(
      <MarkdownEditor ref={ref} initialValue="# hello" ariaLabel="Body" />,
    );
    expect(cmGetValue(view.container)).toBe("# hello");
    expect(ref.current?.getValue()).toBe("# hello");
    ref.current?.setValue("replaced");
    expect(cmGetValue(view.container)).toBe("replaced");
  });

  it("reports edits through onChange", () => {
    const onChange = vi.fn();
    const view = render(<MarkdownEditor onChange={onChange} />);
    cmSetValue(view.container, "typed");
    expect(onChange).toHaveBeenLastCalledWith("typed");
  });

  it("shows the placeholder only while empty", () => {
    const view = render(<MarkdownEditor placeholder="Write a comment…" />);
    expect(cmPlaceholder(view.container)).toBe("Write a comment…");
    cmSetValue(view.container, "x");
    expect(cmPlaceholder(view.container)).toBe("");
  });

  it("submits on Mod-Enter with the current document", () => {
    const onSubmit = vi.fn();
    const view = render(<MarkdownEditor onSubmit={onSubmit} />);
    cmSetValue(view.container, "ship it");
    cmPressKey(view.container, "Enter", { ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    const view = render(<MarkdownEditor onCancel={onCancel} />);
    cmPressKey(view.container, "Escape");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("leaves Mod-Enter dead when no submit handler is given", () => {
    const view = render(<MarkdownEditor initialValue="text" />);
    const cm = cmView(view.container);
    cm.dispatch({ selection: { anchor: 4 } });
    cmPressKey(view.container, "Enter", { ctrlKey: true });
    cmPressKey(view.container, "Escape");
    // A key that submits everywhere else must not silently add a line here.
    expect(cmGetValue(view.container)).toBe("text");
  });

  it("inserts a blank line on Alt-Enter", () => {
    const view = render(<MarkdownEditor initialValue="text" />);
    cmView(view.container).dispatch({ selection: { anchor: 4 } });
    cmPressKey(view.container, "Enter", { altKey: true });
    expect(cmGetValue(view.container)).toBe("text\n");
  });

  it("inserts a blank line on Alt-Enter even when submit is one key away", () => {
    const onSubmit = vi.fn();
    const view = render(
      <MarkdownEditor initialValue="text" onSubmit={onSubmit} />,
    );
    cmView(view.container).dispatch({ selection: { anchor: 4 } });
    cmPressKey(view.container, "Enter", { altKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(cmGetValue(view.container)).toBe("text\n");
  });

  it("forwards paste and drop to the staging handlers", () => {
    const onPaste = vi.fn();
    const onDrop = vi.fn();
    const view = render(<MarkdownEditor onPaste={onPaste} onDrop={onDrop} />);
    const content = cmView(view.container).contentDOM;
    content.dispatchEvent(
      new Event("paste", { bubbles: true, cancelable: true }),
    );
    content.dispatchEvent(
      new Event("drop", { bubbles: true, cancelable: true }),
    );
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("names the field for assistive tech", () => {
    const view = render(<MarkdownEditor ariaLabel="Description" />);
    expect(cmView(view.container).contentDOM.getAttribute("aria-label")).toBe(
      "Description",
    );
  });

  it("keeps multiple selection ranges, so Mod-D can build a multi-cursor", () => {
    const view = render(<MarkdownEditor initialValue="aa bb aa" />);
    const cm = cmView(view.container);
    cm.dispatch({ selection: { anchor: 0, head: 2 } });
    cmPressKey(view.container, "d", { ctrlKey: true });
    expect(cm.state.selection.ranges.length).toBe(2);
  });

  it("stops accepting edits when read-only", () => {
    const view = render(<MarkdownEditor initialValue="fixed" readOnly />);
    const cm = cmView(view.container);
    expect(cm.state.readOnly).toBe(true);
    view.rerender(<MarkdownEditor initialValue="fixed" readOnly={false} />);
    expect(cm.state.readOnly).toBe(false);
  });

  it("applies caller extensions and reconfigures them", () => {
    const first = EditorView.editable.of(false);
    const view = render(<MarkdownEditor extensions={first} />);
    const cm = cmView(view.container);
    expect(cm.state.facet(EditorView.editable)).toBe(false);
    view.rerender(<MarkdownEditor extensions={[]} />);
    expect(cm.state.facet(EditorView.editable)).toBe(true);
  });

  /**
   * happy-dom has no layout engine, so the thing these three declarations buy —
   * the contenteditable filling the editor box, so the blank area below a short
   * document is clickable — cannot be measured here; that is checked in a real
   * browser. What is checked here is the one part that silently breaks: the
   * cascade. CodeMirror's base theme fights all three (`height: 100%` on the
   * scroller, `min-height: 100%` on the content, and `align-items: flex-start
   * !important` on the scroller), so a CodeMirror upgrade that adds
   * `!important` to one more rule — or a tidy-up that drops these lines — puts
   * the editor back to being a dead shell with a live first line.
   */
  it("wins the cascade that lets the contenteditable fill the editor box", () => {
    const view = render(<MarkdownEditor />);
    const scroller = view.container.querySelector(".cm-scroller");
    const content = view.container.querySelector(".cm-content");
    expect(scroller).not.toBeNull();
    expect(content).not.toBeNull();
    expect(getComputedStyle(scroller as HTMLElement).flexGrow).toBe("1");
    expect(getComputedStyle(content as HTMLElement).alignSelf).toBe("stretch");
    expect(getComputedStyle(content as HTMLElement).minHeight).toBe(
      "min-content",
    );
  });
});
