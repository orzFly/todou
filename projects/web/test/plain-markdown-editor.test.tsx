import { hasUnsavedWork } from "@orz/ui/lib/unsaved-guard";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type StagedFiles,
  StagedFileTray,
  useStagedFiles,
} from "../src/components/issue/staged-files.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../src/components/shared/markdown-editor.tsx";
import {
  PLAIN_TEXT_EDITOR_STORAGE_KEY,
  setPlainTextEditor,
} from "../src/lib/plain-text-editor.ts";
import { testQueryClient } from "./render.tsx";

beforeEach(() => setPlainTextEditor(true));
afterEach(() => {
  setPlainTextEditor(false);
  vi.restoreAllMocks();
});

function box(root: ParentNode, index = 0): HTMLTextAreaElement {
  const found = root.querySelectorAll<HTMLTextAreaElement>(
    'textarea[data-slot="markdown-editor"]',
  );
  const el = found[index];
  if (el === undefined) throw new Error(`no plain editor at ${index}`);
  return el;
}

/** What typing does: the value changes, then `input` fires. */
function type(el: HTMLTextAreaElement, value: string) {
  el.value = value;
  fireEvent.input(el);
}

const image = (name: string) =>
  new File(["bytes"], name, { type: "image/png" });

describe("the browser setting (T-709)", () => {
  it("is kept in this browser's storage", () => {
    expect(localStorage.getItem(PLAIN_TEXT_EDITOR_STORAGE_KEY)).toBe("on");
    setPlainTextEditor(false);
    expect(localStorage.getItem(PLAIN_TEXT_EDITOR_STORAGE_KEY)).toBeNull();
  });

  it("mounts a textarea in place of CodeMirror", () => {
    const view = render(<MarkdownEditor initialValue="# hi" />);
    expect(box(view.container).value).toBe("# hi");
    expect(view.container.querySelector(".cm-editor")).toBeNull();
  });

  it("leaves an editor already open as it was when switched", () => {
    const view = render(<MarkdownEditor initialValue="draft" />);
    act(() => setPlainTextEditor(false));
    expect(box(view.container).value).toBe("draft");
    view.rerender(<MarkdownEditor initialValue="draft" />);
    expect(view.container.querySelector(".cm-editor")).toBeNull();
  });
});

describe("PlainMarkdownEditor", () => {
  it("reads and writes through the same handle", () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const view = render(
      <MarkdownEditor ref={ref} initialValue="a" onChange={onChange} />,
    );
    expect(ref.current?.getValue()).toBe("a");
    ref.current?.setValue("b");
    expect(box(view.container).value).toBe("b");
    expect(ref.current?.userChanged()).toBe(false);
    ref.current?.append(" c");
    expect(box(view.container).value).toBe("b c");
    expect(ref.current?.userChanged()).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("b c");
    expect(ref.current?.dismissCompletion()).toBe(false);
  });

  it("reports typing through onChange and marks the reader's change", () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onChange = vi.fn();
    const view = render(<MarkdownEditor ref={ref} onChange={onChange} />);
    type(box(view.container), "typed");
    expect(onChange).toHaveBeenLastCalledWith("typed");
    expect(ref.current?.userChanged()).toBe(true);
  });

  it("submits on Mod-Enter with the current text, and cancels on Escape", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <MarkdownEditor onSubmit={onSubmit} onCancel={onCancel} />,
    );
    const el = box(view.container);
    type(el, "ship it");
    expect(fireEvent.keyDown(el, { key: "Enter", ctrlKey: true })).toBe(false);
    expect(onSubmit).toHaveBeenCalledWith("ship it");
    fireEvent.keyDown(el, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("leaves a plain Enter to the textarea", () => {
    const onSubmit = vi.fn();
    const view = render(<MarkdownEditor onSubmit={onSubmit} />);
    expect(fireEvent.keyDown(box(view.container), { key: "Enter" })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("is dirty only while the text differs from what it opened with", () => {
    const view = render(<MarkdownEditor initialValue="start" />);
    expect(hasUnsavedWork()).toBe(false);
    type(box(view.container), "start and more");
    expect(hasUnsavedWork()).toBe(true);
    type(box(view.container), "start");
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe("file staging in the plain editor", () => {
  function mount(initialValue = "") {
    let latest: StagedFiles | null = null;
    function Harness() {
      const staging = useStagedFiles();
      latest = staging;
      return (
        <>
          <MarkdownEditor
            initialValue={initialValue}
            staging={staging.editor}
          />
          <StagedFileTray staged={staging.staged} onRemove={staging.remove} />
        </>
      );
    }
    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
    return {
      el: box(view.container),
      hook: () => latest as StagedFiles,
    };
  }

  it("places a picked file at the end, and × takes it back out", () => {
    const { el, hook } = mount("note");
    act(() => {
      hook().stage([image("shot.png")]);
    });
    expect(el.value).toMatch(/^note !\[shot\.png\]\(staged:1-\w+\) $/);
    expect(screen.getByTitle("shot.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "remove shot.png" }));
    expect(el.value).toBe("note");
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });

  it("pastes a file at the caret once the reader has pressed in the box", () => {
    const { el } = mount("a b");
    fireEvent.pointerDown(el);
    el.setSelectionRange(1, 1);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        types: ["Files"],
        files: [image("shot.png")],
        getData: () => "",
      },
    });
    act(() => {
      el.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toMatch(/^a !\[shot\.png\]\(staged:1-\w+\) {2}b$/);
    expect(screen.getByTitle("shot.png")).toBeTruthy();
  });

  it("forgets a file whose token the reader deleted", () => {
    const { el, hook } = mount();
    act(() => {
      hook().stage([image("shot.png")]);
    });
    type(el, "");
    expect(screen.queryByTitle("shot.png")).toBeNull();
  });
});
