import {
  ensureSyntaxTree,
  highlightingFor,
  syntaxTree,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { IssueMetadataEntry } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { metadataJsonSupport } from "../src/lib/editor/json-lang.ts";
import {
  appendNewEntry,
  insertKeyInGroup,
  metadataBulkSupport,
  selectValueOf,
} from "../src/lib/editor/metadata-bulk-lang.ts";
import {
  parseBulk,
  scanBulkEntries,
  serializeBulk,
} from "../src/lib/metadata-bulk.ts";

let clock = 0;
/** A minimal entry with throwaway provenance; the syntax layer never reads it. */
const entry = (
  namespace: string,
  key: string,
  value: string,
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at: new Date(1_700_000_000_000 + clock++ * 1_000).toISOString(),
  updated_by: {
    id: 1,
    login: "ci-bridge",
    display_name: "ci-bridge",
    kind: "machine",
    avatar_url: null,
    owner: null,
  },
});

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

  it("selects the body of a heredoc entry, not its intro", () => {
    // Falsifies by: keeping the selection on the first line — the reader
    // gets `<<EOF2` selected and types the syntax away instead of the value.
    const doc = serializeBulk([entry("ci", "k", "body\nEOF\nmore")]);
    expect(doc).toBe("ci/k = <<EOF2\nbody\nEOF\nmore\nEOF2");
    const { view } = mount(doc);
    selectValueOf(view, "ci", "k");
    expect(selectionSlice(view.state)).toBe("body\nEOF\nmore");
  });

  it("starts the selection below the intro when the value looks like one", () => {
    // The text assertion alone cannot judge this document: selecting the
    // intro line and selecting the body both slice out `<<EOF`, so the line
    // the selection begins on is what tells the value from the syntax.
    //
    // Falsifies by: keeping the selection on the first line — the slice
    // stays `<<EOF` and only the line number moves.
    const doc = serializeBulk([entry("ci", "k", "<<EOF")]);
    expect(doc).toBe("ci/k = <<EOF\n<<EOF\nEOF");
    const { view } = mount(doc);
    selectValueOf(view, "ci", "k");
    expect(selectionSlice(view.state)).toBe("<<EOF");
    const selection = view.state.selection.main;
    expect(view.state.doc.lineAt(selection.from).number).toBe(2);
    expect(view.state.doc.lineAt(selection.from).number).not.toBe(
      view.state.doc.lineAt(doc.indexOf("ci/k")).number,
    );
  });

  it("does nothing for a key the traversal cannot find", () => {
    // Falsifies by: dispatching a selection anyway — an entry inside an
    // unterminated heredoc's body is not an entry, and moving the caret
    // there would put the next keystroke inside someone else's value.
    const { view } = mount("ci/k = <<EOF\ndeploy/host = todou");
    selectValueOf(view, "deploy", "host");
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
  });
});

/** Every node of one type in the tree, in document order. */
function nodesNamed(
  state: EditorState,
  name: string,
): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== name) return;
      found.push({
        line: state.doc.lineAt(node.from).number,
        text: state.sliceDoc(node.from, node.to),
      });
    },
  });
  return found;
}

/**
 * The document shapes the Bulk highlighter has to tell apart. Two of them
 * carry a heredoc body whose lines read like entries — the case the
 * highlighter used to colour as if they were.
 */
const HIGHLIGHT_SHAPES: Array<{ name: string; doc: string }> = [
  { name: "single entry", doc: "ci/status = passing" },
  { name: "two entries", doc: "ci/status = passing\ndeploy/host = todou" },
  { name: "comment above an entry", doc: "# note\nci/status = passing" },
  {
    name: "body line shaped like an entry",
    doc: "ci/out = <<EOF\nci/fake = 1\nEOF\nci/x = 2",
  },
  { name: "value that is itself an intro", doc: "ci/k = <<EOF\n<<EOF\nEOF" },
  { name: "ordinary body", doc: "ci/out = <<EOF\nbody\nEOF\nci/x = 2" },
];

/**
 * Values whose heredoc body holds a line the highlighter would colour if it
 * placed the body's end anywhere but where the parser does. Each pairs a
 * line that tempts an early close — identifier-shaped, or spelled like a
 * mark — with an entry-shaped line behind it, which is the one that shows.
 */
const BODIES_WITH_ENTRY_LINES = [
  "E\nci/fake = 1",
  "EOF\nci/fake = 1",
  "EOF2\nci/fake = 1",
  "ci/fake = 1\nEOF",
  "<<EOF\nci/fake = 1",
  "  EOF  \nci/fake = 1",
  "ci/a = 1\nci/b = 2",
  "\nci/fake = 1\n",
];

/** Whether a line would be read as an entry, and so coloured. */
function entryShaped(line: string): boolean {
  const equals = line.indexOf("=");
  if (equals === -1) return false;
  const left = line.slice(0, equals);
  const slash = left.indexOf("/");
  const from = left.length - left.trimStart().length;
  return (
    slash > from && equals - (left.length - left.trimEnd().length) > slash + 1
  );
}

describe("Bulk tab highlighting", () => {
  it("colours the namespace of entry lines only, never a heredoc body line", () => {
    // Falsifies by: measuring the heredoc intro from wherever the tokenizer
    // stopped instead of from the `=`. The body state is then never
    // entered and `ci/fake = 1`, a body line, is coloured as an entry.
    //
    // The assertion is the whole node array: "some MetadataNamespace node
    // exists" holds just as well when the body line carries one.
    const { view } = mount("ci/out = <<EOF\nci/fake = 1\nEOF\nci/x = 2");
    expect(nodesNamed(view.state, "MetadataNamespace")).toEqual([
      { line: 1, text: "ci" },
      { line: 4, text: "ci" },
    ]);
  });

  it("emits exactly one key node per entry line, across every shape", () => {
    // Falsifies by: no `MetadataKey` ever being returned — which is how the
    // token table and the highlight style came to be dead configuration.
    //
    // The assertion is the whole array per shape: "the tree contains a
    // MetadataKey somewhere" holds when one entry line emits one and every
    // other entry line emits none.
    const expected: Record<string, Array<{ line: number; text: string }>> = {
      "single entry": [{ line: 1, text: "status" }],
      "two entries": [
        { line: 1, text: "status" },
        { line: 2, text: "host" },
      ],
      "comment above an entry": [{ line: 2, text: "status" }],
      "body line shaped like an entry": [
        { line: 1, text: "out" },
        { line: 4, text: "x" },
      ],
      "value that is itself an intro": [{ line: 1, text: "k" }],
      "ordinary body": [
        { line: 1, text: "out" },
        { line: 4, text: "x" },
      ],
    };
    for (const { name, doc } of HIGHLIGHT_SHAPES) {
      const { view } = mount(doc);
      expect(nodesNamed(view.state, "MetadataKey"), name).toEqual(
        expected[name],
      );
    }
  });

  /**
   * The price of letting the highlighter keep a recognition of its own.
   * `StreamLanguage.token` sees one line and a mutable state, never the
   * document, so it cannot call `scanBulkEntries` the way `selectValueOf`
   * does — and a second recognition is worth having only while it cannot
   * drift from the first.
   *
   * The reading is indirect: a line counts as inside a body when it carries
   * none of the three node types. That set also holds the end-mark line,
   * which is why it is compared against every line a span covers past its
   * start rather than against the body alone.
   *
   * Being indirect, it can only see a body-boundary error on a line that
   * would otherwise be styled — so the corpus has to contain body lines
   * shaped like entries, which the alphabet alone never produces (it has no
   * `/`). `BODIES_WITH_ENTRY_LINES` is that half, and without it this
   * assertion holds no matter where the highlighter thinks a body ends.
   *
   * Falsifies by: closing the body on any identifier-shaped line instead of
   * the mark itself, or narrowing the intro against `HEREDOC_INTRO`, such
   * as refusing a digit in the mark. Widening it — a dot in the mark, say —
   * is invisible here and everywhere else the serializer writes the text,
   * because the only intros it ever emits are `EOF` and `EOF` plus a digit.
   */
  it("agrees with the shared traversal about where every heredoc body is", () => {
    const alphabet = ["<", '"', "\n", " ", "E", "O", "F"];
    const values = [""];
    let level = [""];
    for (let length = 1; length <= 4; length++) {
      const next: string[] = [];
      for (const prefix of level) {
        for (const character of alphabet) next.push(prefix + character);
      }
      values.push(...next);
      level = next;
    }
    expect(values.length).toBe(2801);
    values.push(...BODIES_WITH_ENTRY_LINES);

    const divergent: string[] = [];
    let bodyLinesSeen = 0;
    let styleableBodyLines = 0;
    for (const value of values) {
      const doc = serializeBulk([entry("ci", "k", value)]);
      const state = EditorState.create({
        doc,
        extensions: [metadataBulkSupport],
      });
      ensureSyntaxTree(state, doc.length, 5000);
      const styled = new Set<number>();
      syntaxTree(state).iterate({
        enter: (node) => {
          if (
            node.name === "MetadataNamespace" ||
            node.name === "MetadataKey" ||
            node.name === "MetadataComment"
          ) {
            styled.add(state.doc.lineAt(node.from).number);
          }
        },
      });
      const byHighlighter: number[] = [];
      for (let line = 1; line <= state.doc.lines; line++) {
        if (!styled.has(line)) byHighlighter.push(line);
      }
      const byScanner: number[] = [];
      for (const span of scanBulkEntries(doc)) {
        for (let line = span.startLine + 1; line <= span.endLine; line++) {
          byScanner.push(line);
          if (entryShaped(state.doc.line(line).text)) styleableBodyLines++;
        }
      }
      bodyLinesSeen += byScanner.length;
      if (byHighlighter.join(",") !== byScanner.join(",")) {
        divergent.push(JSON.stringify(value));
      }
    }
    // Without a body line the assertion holds on any corpus of plain
    // entries, and without a body line the highlighter would style if it
    // misjudged the boundary, it holds however the boundary is misjudged.
    expect(bodyLinesSeen).toBeGreaterThan(0);
    expect(styleableBodyLines).toBeGreaterThan(0);
    expect(
      divergent,
      `${divergent.length} documents were read differently: ${divergent.slice(0, 20).join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the namespace coloured on a line still being typed", () => {
    // A line with no `=` is not yet an entry, and the parser calls it an
    // error — but the colour is what tells someone mid-keystroke that the
    // namespace half has landed. Falsifies by: requiring an `=` before any
    // colour at all, which takes the namespace colour away while typing.
    const { view } = mount("ci/stat");
    expect(nodesNamed(view.state, "MetadataNamespace")).toEqual([
      { line: 1, text: "ci" },
    ]);
    expect(nodesNamed(view.state, "MetadataKey")).toEqual([]);
  });

  it("carries both classes through to the rendered lines", () => {
    // The tree is not the screen: a token can be emitted and still resolve
    // to no class if the highlight style and the token table disagree about
    // the tag. Falsifies by: dropping either mapping for `tags.labelName`.
    const { view } = mount("ci/out = <<EOF\nci/fake = 1\nEOF\nci/x = 2");
    const namespaceClass = highlightingFor(view.state, [tags.namespace]);
    const keyClass = highlightingFor(view.state, [tags.labelName]);
    expect(namespaceClass).not.toBe("");
    expect(keyClass).not.toBe("");
    const lines = [...view.contentDOM.querySelectorAll(".cm-line")];
    expect(lines).toHaveLength(4);
    expect(lines[0]?.innerHTML).toContain(namespaceClass);
    expect(lines[0]?.innerHTML).toContain(keyClass);
    // The body line reads like an entry and must render as plain text.
    expect(lines[1]?.innerHTML).not.toContain(namespaceClass);
    expect(lines[1]?.innerHTML).not.toContain(keyClass);
    expect(lines[3]?.innerHTML).toContain(namespaceClass);
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

/**
 * The insertion-point suite. Every text assertion is a whole-string
 * equality on `view.state.doc.toString()`: a glued entry ("todoudeploy/key
 * = value") still *contains* `deploy/key = value`, so a `toContain` here
 * cannot see the defect — only exact equality can.
 */
describe("insertion points and separators", () => {
  /** N11: after inserting, parsing must show exactly one new entry, every
   * pre-existing entry byte-identical. Any glue — into a neighbour's value
   * or into a heredoc body — fails the strict equality on the value. */
  function expectRoundTrip(
    doc: string,
    action: (view: EditorView) => void,
    inserted: { id: string; value: string },
  ): void {
    const { view } = mount(doc);
    const before = parseBulk(doc);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    action(view);
    const result = parseBulk(view.state.doc.toString());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exactly one entry more than before…
    expect(result.entries.size).toBe(before.entries.size + 1);
    // …every original value verbatim…
    for (const [id, value] of before.entries) {
      expect(result.entries.get(id)).toBe(value);
    }
    // …and the new entry present with its pristine placeholder value.
    expect(result.entries.get(inserted.id)).toBe(inserted.value);
  }

  it("N1: appends to the last group with no trailing newline, on its own line", () => {
    // Falsifies by: restoring `sep = at < doc.length ? "\n" : ""` — the
    // separator goes empty at EOF and the text glues into
    // `deploy/host = todoudeploy/key = value`.
    const doc = "ci/status = passing\n\ndeploy/host = todou";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\n\ndeploy/host = todou\ndeploy/key = value",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "deploy"), {
      id: "deploy/key",
      value: "value",
    });
  });

  it("N2: single-group document, new entry on its own line", () => {
    // Falsifies by: same regression as N1 — with one group the buggy
    // branch is the only path (at === doc.length), glue is guaranteed.
    const doc = "ci/status = passing";
    const { view } = mount(doc);
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\nci/key = value",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "ci"), {
      id: "ci/key",
      value: "value",
    });
  });

  it("N3: trailing newline is kept, exactly one newline added, no extra blank", () => {
    // Falsifies by: taking the insertion point as doc.length — the entry
    // lands after the trailing newline and the whole-text equality fails.
    const doc = "ci/status = passing\ndeploy/host = todou\n";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\ndeploy/host = todou\ndeploy/key = value\n",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "deploy"), {
      id: "deploy/key",
      value: "value",
    });
  });

  it("N4: non-last group still inserts at the group's end, before the next", () => {
    // Falsifies by: taking the insertion point as doc.length — the new
    // entry jumps past the deploy group to the end of the document.
    const doc = "ci/status = passing\n\ndeploy/host = todou";
    const { view } = mount(doc);
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\nci/key = value\n\ndeploy/host = todou",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "ci"), {
      id: "ci/key",
      value: "value",
    });
  });

  it("N5: namespace absent — starts a new group after a blank line", () => {
    // Falsifies by: using want = 1 in the null branch — the new entry
    // merges into the deploy group instead of opening its own.
    const doc = "ci/status = passing\n\ndeploy/host = todou";
    const { view } = mount(doc);
    insertKeyInGroup(view, "metrics");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\n\ndeploy/host = todou\n\nmetrics/key = value",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "metrics"), {
      id: "metrics/key",
      value: "value",
    });
  });

  it("N6: absent namespace with trailing newline — still exactly one blank line", () => {
    // Falsifies by: writing "\n\n" unconditionally — the existing trailing
    // newline plus two more leaves two blank lines.
    const doc = "ci/status = passing\n\ndeploy/host = todou\n";
    const { view } = mount(doc);
    insertKeyInGroup(view, "metrics");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\n\ndeploy/host = todou\n\nmetrics/key = value\n",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "metrics"), {
      id: "metrics/key",
      value: "value",
    });
  });

  it("N7: empty document — no leading separator", () => {
    // Falsifies by: writing a separator unconditionally — the text starts
    // with one or two newlines.
    const { view } = mount("");
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe("ci/key = value");
    // Two toolbar actions never share one synchronous turn with the caret
    // parked in a fresh snippet field, and happy-dom needs that modelled:
    // it dispatches `selectionchange` inline from the call that moves the
    // selection, where the DOM spec queues it, so the second dispatch
    // re-enters CM's update and trips its own guard.
    view.contentDOM.blur();
    appendNewEntry(view);
    // Second entry on the empty-ish document: separated as a new group.
    expect(view.state.doc.toString()).toBe("ci/key = value\n\nns/key = value");
  });

  it("N8: last group ends with a heredoc — entry goes after the end mark", () => {
    // Falsifies by: restoring the reverse `startsWith(ns/)` line scan — it
    // hits the intro line (or a body line), and the new entry lands inside
    // the heredoc body.
    const doc =
      "ci/status = passing\n\ndeploy/host = todou\ndeploy/notes = <<EOF\nline one\nEOF";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\n\ndeploy/host = todou\ndeploy/notes = <<EOF\nline one\nEOF\ndeploy/key = value",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "deploy"), {
      id: "deploy/key",
      value: "value",
    });
  });

  it("N9: heredoc in a middle group — entry after the mark, before the next group", () => {
    // Falsifies by: the same startsWith scan — it hits the intro line and
    // inserts the entry into the body; the next group then swallows it.
    const doc =
      "ci/status = passing\nci/out = <<EOF\nbody\nEOF\n\ndeploy/host = todou";
    const { view } = mount(doc);
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\nci/out = <<EOF\nbody\nEOF\nci/key = value\n\ndeploy/host = todou",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "ci"), {
      id: "ci/key",
      value: "value",
    });
  });

  it("N10: heredoc is the group's last entry with a lookalike body line — not treated as the group end", () => {
    // Falsifies by: the startsWith scan — `deploy/fake = 1` sits in the
    // body, matches the `deploy/` prefix, and the new entry is inserted
    // right after that body line (inside the heredoc). parseBulk then
    // silently folds both lines into notes' value.
    const doc =
      "deploy/host = todou\ndeploy/notes = <<EOF\ndeploy/fake = 1\nEOF";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "deploy/host = todou\ndeploy/notes = <<EOF\ndeploy/fake = 1\nEOF\ndeploy/key = value",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "deploy"), {
      id: "deploy/key",
      value: "value",
    });
  });

  it("N11: table-driven round trip — every shape parses with values verbatim plus the new entry", () => {
    // Falsifies by: any glue. Gluing the snippet onto the previous line
    // folds the new text into the neighbour's value; the strict toBe on
    // the neighbour's value then fails. Each row also pins the exact text.
    const shapes: Array<{
      name: string;
      doc: string;
      namespace: string;
      expected: string;
    }> = [
      {
        name: "last group, no trailing newline",
        doc: "ci/status = passing\n\ndeploy/host = todou",
        namespace: "deploy",
        expected:
          "ci/status = passing\n\ndeploy/host = todou\ndeploy/key = value",
      },
      {
        name: "single group",
        doc: "ci/status = passing",
        namespace: "ci",
        expected: "ci/status = passing\nci/key = value",
      },
      {
        name: "trailing newline",
        doc: "ci/status = passing\ndeploy/host = todou\n",
        namespace: "deploy",
        expected:
          "ci/status = passing\ndeploy/host = todou\ndeploy/key = value\n",
      },
      {
        name: "non-last group",
        doc: "ci/status = passing\n\ndeploy/host = todou",
        namespace: "ci",
        expected: "ci/status = passing\nci/key = value\n\ndeploy/host = todou",
      },
      {
        name: "heredoc last entry",
        doc: "ci/status = passing\n\ndeploy/host = todou\ndeploy/notes = <<EOF\nline one\nEOF",
        namespace: "deploy",
        expected:
          "ci/status = passing\n\ndeploy/host = todou\ndeploy/notes = <<EOF\nline one\nEOF\ndeploy/key = value",
      },
      {
        name: "heredoc middle group with lookalike body line",
        doc: "ci/status = passing\nci/out = <<EOF\nci/fake = 1\nEOF\n\ndeploy/host = todou",
        namespace: "ci",
        expected:
          "ci/status = passing\nci/out = <<EOF\nci/fake = 1\nEOF\nci/key = value\n\ndeploy/host = todou",
      },
    ];
    for (const { name, doc, namespace, expected } of shapes) {
      const { view } = mount(doc);
      insertKeyInGroup(view, namespace);
      expect(view.state.doc.toString(), name).toBe(expected);
      const result = parseBulk(view.state.doc.toString());
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      // The parse must show exactly one more entry than the original text.
      const before = parseBulk(doc);
      expect(before.ok, name).toBe(true);
      if (!before.ok) continue;
      expect(result.entries.size, name).toBe(before.entries.size + 1);
      // Every neighbour's value verbatim.
      for (const [id, value] of before.entries) {
        expect(result.entries.get(id), `${name}: ${id}`).toBe(value);
      }
      expect(result.entries.get(`${namespace}/key`), name).toBe("value");
    }
  });

  it("N12: appendNewEntry on a document with trailing newline — exactly one blank line", () => {
    // Falsifies by: restoring the hardcoded "\n\n" — combined with the
    // trailing newline it leaves two blank lines before the entry.
    const doc = "ci/status = passing\ndeploy/host = todou\n";
    const { view } = mount(doc);
    appendNewEntry(view);
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\ndeploy/host = todou\n\nns/key = value\n",
    );
    expectRoundTrip(doc, (v) => appendNewEntry(v), {
      id: "ns/key",
      value: "value",
    });
  });

  it("N13: appendNewEntry without trailing newline — blank line, not glue", () => {
    // Falsifies by: dropping the separator entirely — the template glues
    // onto the last line: `todouns/key = value`.
    const doc = "ci/status = passing\ndeploy/host = todou";
    const { view } = mount(doc);
    appendNewEntry(view);
    expect(view.state.doc.toString()).toBe(
      "ci/status = passing\ndeploy/host = todou\n\nns/key = value",
    );
    expectRoundTrip(doc, (v) => appendNewEntry(v), {
      id: "ns/key",
      value: "value",
    });
  });

  it("N14: unterminated heredoc with a complete entry earlier in the group — insert before the broken heredoc", () => {
    // Falsifies by: taking the insertion point as doc.length — the new
    // entry lands inside the still-open heredoc body. The scan stops at
    // the unterminated intro, so the point is the end of the last
    // complete entry's line (deploy/host), before `deploy/notes`.
    const doc = "deploy/host = todou\ndeploy/notes = <<EOF\nstill typing";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "deploy/host = todou\ndeploy/key = value\ndeploy/notes = <<EOF\nstill typing",
    );
  });

  it("N15: unterminated heredoc is the namespace's only entry — insert as a new group at the scan's end", () => {
    // The reviewer's shape (#comment-4067): no complete entry for the
    // namespace exists before the scan stops, so this takes the "namespace
    // absent" path — a new group at the end of the *scanned* text, i.e.
    // after `ci/x = 0`, before the broken heredoc's intro line. The entry
    // never lands inside the body.
    //
    // Falsifies by: taking the insertion point as doc.length — the entry
    // lands after `still typing`, inside the body.
    const doc = "ci/x = 0\ndeploy/notes = <<EOF\nstill typing";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "ci/x = 0\n\ndeploy/key = value\ndeploy/notes = <<EOF\nstill typing",
    );
  });

  it("N16: appendNewEntry with an unterminated heredoc — at the scan's end, never inside the body", () => {
    // Falsifies by: taking the insertion point as doc.length — the appended
    // template joins the heredoc body: `...<<EOF\nstill typing\n\nns/key = value`.
    const doc = "deploy/host = todou\ndeploy/notes = <<EOF\nstill typing";
    const { view } = mount(doc);
    appendNewEntry(view);
    expect(view.state.doc.toString()).toBe(
      "deploy/host = todou\n\nns/key = value\ndeploy/notes = <<EOF\nstill typing",
    );
  });

  it("N17: appendNewEntry on a document with no complete entry — after the text, never glued", () => {
    // Zero-span shape (blocking review): `scanEnd` used to return 0 on a
    // zero-span document; the separator survived but the template landed
    // at the TOP of the text — not the old code's end-of-text append.
    //
    // Falsifies by: restoring `if (spans.length === 0) return 0;` —
    // exactly this test goes red, and the red shape is a WHOLE-STRING
    // mismatch: the text becomes "ns/key = value\n\ntodo" (template first,
    // original text pushed below). No glue: with the line-start rule in
    // place, position 0 still separates. The N1-style glue
    // ("ns/key = valuetodo") is unreachable on this path.
    const doc = "todo";
    const { view } = mount(doc);
    appendNewEntry(view);
    expect(view.state.doc.toString()).toBe("todo\n\nns/key = value");
  });

  it("N18: insertKeyInGroup on a comments-only document — new group after the comment", () => {
    // Same zero-span shape, comment-only: the scan covers the whole text
    // (a comment yields no span) so the end is text.length.
    //
    // Falsifies by: the same `return 0` — exactly this test goes red with
    // the text reading "ci/key = value\n\n# nothing here yet" (entry
    // above the comment), again no glue.
    const doc = "# nothing here yet";
    const { view } = mount(doc);
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe(
      "# nothing here yet\n\nci/key = value",
    );
  });

  it("N19: unterminated heredoc is the text's only entry candidate — new group before the intro line", () => {
    // The zero-span rule's heredoc half (#comment-4117): no complete entry
    // exists, the scan stops at the intro line, and the new group goes
    // before that line — not at offset 0 as glue, not inside the body.
    // Falsifies by: `return 0` — "deploy/key = valuedeploy/notes = <<EOF…".
    const doc = "deploy/notes = <<EOF\nstill typing";
    const { view } = mount(doc);
    insertKeyInGroup(view, "deploy");
    expect(view.state.doc.toString()).toBe(
      "deploy/key = value\n\ndeploy/notes = <<EOF\nstill typing",
    );
  });

  it("N20: group after an unterminated heredoc — its + key still finds it", () => {
    // The group exists but sits after the scan's stop; the insertion point
    // is the scan's end (before the intro line), not the document top.
    // Falsifies by: `return 0` — the entry jumps above everything.
    const doc = "deploy/notes = <<EOF\nstill typing\n\nci/x = 0";
    const { view } = mount(doc);
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe(
      "ci/key = value\n\ndeploy/notes = <<EOF\nstill typing\n\nci/x = 0",
    );
  });

  it("N22: a value that is itself a heredoc intro — new key after the end mark", () => {
    // A `<<`-leading value only started occupying three lines when the
    // serializer stopped writing it plainly, so this text had never reached
    // the insertion point before. The body line is a lookalike intro, which
    // is what makes it worth a case of its own.
    //
    // Falsifies by: locating the group's end with a `ns/` prefix scan
    // instead of the shared span — the scan stops on the body line and the
    // new key lands inside the heredoc, taking both the entry count and
    // `ci/out`'s value with it. The document is built by the serializer, so
    // the case follows the rendering rather than restating it.
    const doc = serializeBulk([
      entry("ci", "note", "plain"),
      entry("ci", "out", "<<EOF"),
    ]);
    expect(doc).toBe("ci/note = plain\nci/out = <<EOF\n<<EOF\nEOF");
    const { view } = mount(doc);
    insertKeyInGroup(view, "ci");
    expect(view.state.doc.toString()).toBe(
      "ci/note = plain\nci/out = <<EOF\n<<EOF\nEOF\nci/key = value",
    );
    expectRoundTrip(doc, (v) => insertKeyInGroup(v, "ci"), {
      id: "ci/key",
      value: "value",
    });
  });

  it("N21: appendNewEntry before an unterminated intro that opens the text", () => {
    // Same boundary, appendNewEntry: the intro opens the text, so the
    // template goes before it and the unread body stays below.
    // Falsifies by: `return 0` without the line-start rule — the template
    // glues onto the intro line's head.
    const doc = "deploy/notes = <<EOF\nstill typing";
    const { view } = mount(doc);
    appendNewEntry(view);
    expect(view.state.doc.toString()).toBe(
      "ns/key = value\n\ndeploy/notes = <<EOF\nstill typing",
    );
  });
});
