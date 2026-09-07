import { EditorView } from "@codemirror/view";

/**
 * Test-side reach into a MarkdownEditor. The document lives in the
 * EditorView, not in the DOM, so `fireEvent.change` on an element has
 * nothing to change — go through the view instead.
 */
export function cmView(root: ParentNode, index = 0): EditorView {
  const hosts = root.querySelectorAll<HTMLElement>(
    '[data-slot="markdown-editor"]',
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

export function cmCount(root: ParentNode): number {
  return root.querySelectorAll('[data-slot="markdown-editor"]').length;
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
    '[data-slot="markdown-editor"]',
  )[index];
  return host?.querySelector(".cm-placeholder")?.textContent ?? "";
}
