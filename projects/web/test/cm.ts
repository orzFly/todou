import type { Completion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";

/**
 * Test-side reach into a MarkdownEditor. The document lives in the
 * EditorView, not in the DOM, so `fireEvent.change` on an element has
 * nothing to change — go through the view instead.
 */
export function cmView(root: ParentNode, index = 0): EditorView {
  const hosts = root.querySelectorAll<HTMLElement>(
    '[data-slot="markdown-editor"], [data-slot="code-editor"]',
  );
  const host = hosts[index];
  if (host === undefined) {
    throw new Error(
      `no markdown editor at index ${index} (found ${hosts.length})`,
    );
  }
  const content = host.querySelector<HTMLElement>(".cm-content");
  const view = content === null ? null : EditorView.findFromDOM(content);
  if (view === null) throw new Error("markdown editor has no EditorView");
  return view;
}
/** Apply a completion option to a real view and return its exact document. */
export function acceptInto(
  option: Completion,
  doc: string,
  from: number,
  to: number,
): string {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: to },
    }),
  });
  const apply = option.apply ?? option.label;
  if (typeof apply === "string") {
    view.dispatch({
      changes: { from, to, insert: apply },
      selection: { anchor: from + apply.length },
    });
  } else {
    apply(view, option, from, to);
  }
  const result = view.state.doc.toString();
  view.destroy();
  return result;
}

/**
 * Call the inputHandler facet exactly where CodeMirror's DOM input path does.
 * This proves handler behavior, not the browser-to-handler DOM plumbing.
 */
export function handleViewInput(view: EditorView, text: string): boolean {
  const { from, to } = view.state.selection.main;
  const defaultInsert = () =>
    view.state.update({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.type",
    });
  // @codemirror/view does not expose inputState, so this test-only cast is
  // the boundary needed to mirror 6.43.9's applyDOMChangeInner ordering.
  const internalView = view as unknown as {
    inputState: { composing: number };
  };
  const { inputState } = internalView;
  if (inputState.composing >= 0) inputState.composing += 1;
  return view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, defaultInsert));
}

export function cmHandleInput(
  root: ParentNode,
  text: string,
  index = 0,
): boolean {
  return handleViewInput(cmView(root, index), text);
}
/** Run input handlers, then simulate CodeMirror's default insertion if free. */
export function cmInput(root: ParentNode, text: string, index = 0): boolean {
  const handled = cmHandleInput(root, text, index);
  if (!handled) {
    const view = cmView(root, index);
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.type",
    });
  }
  return handled;
}

export function cmCount(root: ParentNode): number {
  return root.querySelectorAll(
    '[data-slot="markdown-editor"], [data-slot="code-editor"]',
  ).length;
}

export function cmGetValue(root: ParentNode, index = 0): string {
  return cmView(root, index).state.doc.toString();
}

export function cmSetValue(root: ParentNode, value: string, index = 0): void {
  const view = cmView(root, index);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    // Matches what typing produces, so history and updateListener consumers
    // see the same shape they would in a browser.
    userEvent: "input.type",
  });
}

/**
 * Replace the document and leave the cursor at the end of what was inserted,
 * where a completion source looks for the reference being typed.
 */
export function cmType(root: ParentNode, value: string, index = 0): void {
  const view = cmView(root, index);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
    selection: { anchor: value.length },
    userEvent: "input.type",
  });
}

/**
 * Focus the editor the way a click does, through the bubbling event React
 * listens for. Neither `contentDOM.focus()` nor `EditorView.focus()` reaches
 * an `onFocus` on an ancestor under happy-dom; only the dispatched `focusin`
 * does. The `focus()` call keeps the editor's own focus state in step.
 */
export function cmFocus(root: ParentNode, index = 0): void {
  const content = cmView(root, index).contentDOM;
  content.focus();
  fireEvent.focusIn(content);
}

/**
 * Fire a key on the editor's contenteditable, where CodeMirror listens. The
 * event is returned so a caller can read `defaultPrevented`, which is what
 * separates a key the editor handled from one it left to the browser — Tab
 * moving focus, for instance.
 */
export function cmPressKey(
  root: ParentNode,
  key: string,
  modifiers: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = {},
  index = 0,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  cmView(root, index).contentDOM.dispatchEvent(event);
  return event;
}

export function cmPlaceholder(root: ParentNode, index = 0): string {
  const host = root.querySelectorAll<HTMLElement>(
    '[data-slot="markdown-editor"], [data-slot="code-editor"]',
  )[index];
  return host?.querySelector(".cm-placeholder")?.textContent ?? "";
}
