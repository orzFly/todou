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

/** Fire a key on the editor's contenteditable, where CodeMirror listens. */
export function cmPressKey(
  root: ParentNode,
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
  index = 0,
): void {
  cmView(root, index).contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }),
  );
}

export function cmPlaceholder(root: ParentNode, index = 0): string {
  const host = root.querySelectorAll<HTMLElement>(
    '[data-slot="markdown-editor"]',
  )[index];
  return host?.querySelector(".cm-placeholder")?.textContent ?? "";
}
