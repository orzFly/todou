import { highlightingFor, syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { metadataJsonSupport } from "../src/lib/editor/json-lang.ts";
import {
  appendNewEntry,
  insertKeyInGroup,
  metadataBulkSupport,
  selectValueOf,
} from "../src/lib/editor/metadata-bulk-lang.ts";

/**
 * Mount a real EditorView with the Bulk language support, the way the
 * editor panel does. Snippet behaviour lives in CM's keymap and state, so
 * the tests go through the same extension list the product does.
 */
function mount(doc: string, extensions: Extension = metadataBulkSupport) {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [extensions] }),
  });
  return { view, host };
}
/** Text of the currently selected range, the one assertion surface CM6
 * snippet tests have in happy-dom (design: 可测边界). */
function selectionSlice(state: EditorState): string {
  return state.sliceDoc(state.selection.main.from, state.selection.main.to);
}

/**
 * Fire Tab / Shift-Tab on the view's own content element — cm.ts's helpers
 * all start from a `data-slot` host, which a bare EditorView has none of.
 */
function press(view: EditorView, key: string, shift = false): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      shiftKey: shift,
    }),
  );
}

describe("snippet expansion", () => {
  it("lands the first field on `ns` of the appended template", () => {
    // C1. Falsifies by: leaving the cursor on the value placeholder.
    const { view } = mount("");
    appendNewEntry(view);
    expect(view.state.doc.toString()).toContain("ns/key = value");
    expect(selectionSlice(view.state)).toBe("ns");
  });

  it("inserts a key at the end of its namespace group, not the file", () => {
    // C2. Falsifies by: always appending at end-of-document.
    const { view } = mount("ci/status = passing\n\ndeploy/host = todou");
    insertKeyInGroup(view, "ci");
    const text = view.state.doc.toString();
    expect(text.indexOf("ci/key")).toBeLessThan(text.indexOf("deploy/"));
    // Still inside the ci group: the deploy group follows after a blank line.
    expect(text).toContain("ci/key = value\n\ndeploy/host = todou");
  });

  it("prefills the namespace so the first field is the key", () => {
    // C3. Falsifies by: leaving `ns` as a placeholder in the template.
    const { view } = mount("ci/status = passing");
    insertKeyInGroup(view, "ci");
    expect(selectionSlice(view.state)).toBe("key");
  });
});

describe("tabbing through snippet fields", () => {
  it("walks ns → key → value forward, then stops at the last field", () => {
    // C4 — forward chain. Falsifies by: binding Tab to prevSnippetField on
    // the snippetKeymap facet; the chain then runs value → key → ns and the
    // first assertion fails. The binding must be broken on that facet: an
    // ordinary keymap.of is out-shouted by the snippet extension's own
    // Prec.highest keymap and the drill passes silently.
    const { view } = mount("");
    appendNewEntry(view);
    expect(selectionSlice(view.state)).toBe("ns");
    press(view, "Tab");
    expect(selectionSlice(view.state)).toBe("key");
    press(view, "Tab");
    expect(selectionSlice(view.state)).toBe("value");
    // The chain ends here: moveField cleared the snippet state on entry to
    // the last field, so a further Tab neither moves nor re-activates it.
    press(view, "Tab");
    expect(selectionSlice(view.state)).toBe("value");
  });

  it("steps back key → ns, but not from the last field", () => {
    // C4 — backward chain. Falsifies by the same facet rebinding. From
    // `value` there is no going back: the snippet is already over, and
    // Shift-Tab must leave the selection exactly where it was.
    const { view } = mount("");
    appendNewEntry(view);
    press(view, "Tab"); // ns → key
    press(view, "Tab", true);
    expect(selectionSlice(view.state)).toBe("ns");
    // Forward again, then to the end: from value, Shift-Tab does nothing.
    press(view, "Tab");
    press(view, "Tab");
    expect(selectionSlice(view.state)).toBe("value");
    press(view, "Tab", true);
    expect(selectionSlice(view.state)).toBe("value");
  });

  it("keeps a typed first field and advances to the second", () => {
    // C5. Falsifies by: typing over the whole template.
    const { view } = mount("");
    appendNewEntry(view);
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "ci" },
      selection: EditorSelection.cursor(sel.from + 2),
    });
    press(view, "Tab");
    expect(view.state.doc.toString()).toBe("ci/key = value");
    expect(selectionSlice(view.state)).toBe("key");
  });
});

describe("selectValueOf", () => {
  it("selects exactly the value of the requested row", () => {
    // C6. Falsifies by: collapsing the selection to the line start.
    const { view } = mount("ci/status = passing\ndeploy/host = todou");
    selectValueOf(view, "deploy", "host");
    expect(selectionSlice(view.state)).toBe("todou");
  });
});

describe("JSON tab highlighting", () => {
  it("parses the document and resolves a highlight class for strings", () => {
    // J6. Falsifies by: dropping the parser or syntaxHighlighting from the
    // support list — the tree then stays empty and highlightingFor
    // resolves no class for the node.
    const { view, host } = mount(
      '{"ci": {"status": "passing"}}',
      metadataJsonSupport,
    );
    const tree = syntaxTree(view.state);
    // The tree really parsed: a String node exists below the root
    // (getChild only walks one level, and values nest in Properties).
    const cursor = tree.topNode.cursor();
    let sawString = false;
    while (!sawString) {
      if (cursor.name === "String") sawString = true;
      if (!cursor.next()) break;
    }
    expect(sawString).toBe(true);
    const cls = highlightingFor(view.state, [tags.string]);
    expect(cls).not.toBe("");
    // And the content really rendered the document.
    expect(host.querySelector(".cm-content")?.textContent).toContain(
      '"passing"',
    );
  });
});
