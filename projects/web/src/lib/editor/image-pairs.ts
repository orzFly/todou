import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  showTooltip,
  type TooltipView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import {
  createToolbarDom,
  toolbarButton,
  toolbarTheme,
  wireToolbar,
} from "@/lib/editor/editor-toolbar.ts";

/**
 * An author's image pair (T-767) as the editor sees it: two images and an
 * arrow, alone in a paragraph, which the reader gets as one comparison. The
 * editor has no preview, so the arrow turning green is the only sign it will;
 * and since screenshots are pasted one at a time, the moment the second lands
 * under the first is when the editor offers to join them.
 */

// @lezer/common's types, without depending on it directly.
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

const ARROW = /^\s*(?:→|->)\s*$/;
/** What a quote's continuation lines leave between two blocks of it. */
const QUOTED_BLANKS =
  /^(?:[ \t]*(?:>[ \t]?)*[ \t]*\n)*[ \t]*(?:>[ \t]?)*[ \t]*$/;

/** A paragraph's inline children, without the quote marks lines carry. */
function inlineChildren(paragraph: SyntaxNode): SyntaxNode[] {
  const kids: SyntaxNode[] = [];
  for (let c = paragraph.firstChild; c !== null; c = c.nextSibling) {
    if (c.name !== "QuoteMark") kids.push(c);
  }
  return kids;
}

/** The document between two positions, with the quote marks in it taken out. */
function textBetween(
  state: EditorState,
  paragraph: SyntaxNode,
  from: number,
  to: number,
): string {
  let text = "";
  let at = from;
  for (let c = paragraph.firstChild; c !== null; c = c.nextSibling) {
    if (c.name !== "QuoteMark" || c.to <= from || c.from >= to) continue;
    text += state.sliceDoc(at, c.from);
    at = c.to;
  }
  return text + state.sliceDoc(at, to);
}

/**
 * The rule, over the editor's syntax tree: exactly two images, an arrow
 * between them and nothing else. Its twin over the rendered tree is
 * `imagePairOf` in `rehype-image-pairs.ts`; the tests hold both to one table.
 */
export function pairInParagraph(
  state: EditorState,
  paragraph: SyntaxNode,
): { arrowFrom: number; arrowTo: number } | null {
  const kids = inlineChildren(paragraph);
  if (kids.length !== 2 || kids.some((kid) => kid.name !== "Image")) {
    return null;
  }
  const [before, after] = kids;
  if (textBetween(state, paragraph, paragraph.from, before.from).trim() !== "")
    return null;
  if (textBetween(state, paragraph, after.to, paragraph.to).trim() !== "")
    return null;
  if (!ARROW.test(textBetween(state, paragraph, before.to, after.from))) {
    return null;
  }
  const between = state.sliceDoc(before.to, after.from);
  const offset = between.search(/→|->/);
  const length = between.startsWith("→", offset) ? 1 : 2;
  return {
    arrowFrom: before.to + offset,
    arrowTo: before.to + offset + length,
  };
}

const arrowMark = Decoration.mark({
  class: "cm-image-pair-arrow",
  attributes: { title: "Shown as a comparison" },
});

function arrows(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Paragraph") return;
        const pair = pairInParagraph(view.state, node.node);
        if (pair !== null) {
          marks.push(arrowMark.range(pair.arrowFrom, pair.arrowTo));
        }
        return false;
      },
    });
  }
  return Decoration.set(marks, true);
}

const arrowPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = arrows(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = arrows(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** The join on offer: replace `from`–`to` with an arrow; the toolbar sits at `end`. */
type Offer = { from: number; to: number; label: string; end: number };

const setOffer = StateEffect.define<Offer | null>();

/** The image a paragraph holds when it holds nothing else, or null. */
function loneImage(state: EditorState, paragraph: SyntaxNode) {
  const kids = inlineChildren(paragraph);
  if (kids.length !== 1 || kids[0].name !== "Image") return null;
  const [image] = kids;
  if (textBetween(state, paragraph, paragraph.from, image.from).trim() !== "")
    return null;
  if (textBetween(state, paragraph, image.to, paragraph.to).trim() !== "")
    return null;
  return image;
}

/** The two images a paragraph holds when it holds them and only whitespace. */
function twoImages(
  state: EditorState,
  paragraph: SyntaxNode,
): [SyntaxNode, SyntaxNode] | null {
  const kids = inlineChildren(paragraph);
  if (kids.length !== 2 || kids.some((kid) => kid.name !== "Image")) {
    return null;
  }
  const [first, second] = kids;
  const gaps = [
    [paragraph.from, first.from],
    [first.to, second.from],
    [second.to, paragraph.to],
  ];
  if (
    gaps.some(
      ([from, to]) => textBetween(state, paragraph, from, to).trim() !== "",
    )
  ) {
    return null;
  }
  return [first, second];
}

/** The block before `node` in its container, past the quote marks of blank lines. */
function previousBlock(node: SyntaxNode): SyntaxNode | null {
  let prev = node.prevSibling;
  while (prev !== null && prev.name === "QuoteMark") prev = prev.prevSibling;
  return prev;
}

/** The two images as one offer, when only blank lines separate their paragraphs. */
function joinParagraphs(
  state: EditorState,
  first: SyntaxNode,
  second: SyntaxNode,
  label: string,
): Offer | null {
  if (first.name !== "Paragraph" || second.name !== "Paragraph") return null;
  if (previousBlock(second)?.from !== first.from) return null;
  const a = loneImage(state, first);
  const b = loneImage(state, second);
  if (a === null || b === null) return null;
  if (!QUOTED_BLANKS.test(state.sliceDoc(a.to, b.from))) return null;
  return { from: a.to, to: b.from, label, end: b.to };
}

/**
 * The file placeholders in `from`–`to`. Only those: markdown text pasted
 * with images in it already reads the way its author wrote it.
 */
function placeholdersIn(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name !== "Image") return;
      const url = node.node.getChild("URL");
      if (
        node.from >= from &&
        node.to <= to &&
        url !== null &&
        state.sliceDoc(url.from, url.to).startsWith("staged:")
      ) {
        found.push(node.node);
      }
      return false;
    },
  });
  return found;
}

/** What a paste or a drop that just put in `ranges` makes joinable, if anything. */
function offerFor(
  state: EditorState,
  ranges: Array<{ from: number; to: number }>,
): Offer | null {
  const end = ranges.reduce((max, r) => Math.max(max, r.to), 0);
  const tree = ensureSyntaxTree(state, end, 50) ?? syntaxTree(state);
  const images = ranges.flatMap((r) =>
    placeholdersIn(state, tree, r.from, r.to),
  );
  if (images.length === 1) {
    const paragraph = images[0].parent;
    if (paragraph === null) return null;
    // Two pastes in a row land on one line: the caret is still beside the
    // first image when the second arrives.
    if (inlineChildren(paragraph).length === 2) {
      const two = twoImages(state, paragraph);
      if (two === null || two[1].from !== images[0].from) return null;
      return {
        from: two[0].to,
        to: two[1].from,
        label: "Compare with the image before",
        end: two[1].to,
      };
    }
    const prev = previousBlock(paragraph);
    if (prev === null) return null;
    return joinParagraphs(
      state,
      prev,
      paragraph,
      "Compare with the image above",
    );
  }
  if (images.length === 2) {
    const [a, b] = images;
    const pa = a.parent;
    const pb = b.parent;
    if (pa === null || pb === null) return null;
    if (pa.from === pb.from) {
      // Dropped side by side on one line: the paragraph holds just the two.
      if (twoImages(state, pa) === null) return null;
      return { from: a.to, to: b.from, label: "Compare", end: b.to };
    }
    return joinParagraphs(state, pa, pb, "Compare");
  }
  return null;
}

const offerField = StateField.define<Offer | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setOffer)) return effect.value;
    }
    if (
      tr.docChanged &&
      (tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop"))
    ) {
      const ranges: Array<{ from: number; to: number }> = [];
      tr.changes.iterChangedRanges((_fa, _ta, from, to) => {
        if (to > from) ranges.push({ from, to });
      });
      return ranges.length === 0 ? null : offerFor(tr.state, ranges);
    }
    if (value === null) return null;
    // As the paste options do: any other edit or caret move and the images
    // are no longer the ones just put in.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    showTooltip.from(field, (offer) =>
      offer === null
        ? null
        : { pos: offer.end, above: false, create: createOfferToolbar },
    ),
});

function join(view: EditorView) {
  const offer = view.state.field(offerField, false);
  if (!offer) return;
  const insert = " → ";
  view.dispatch({
    changes: { from: offer.from, to: offer.to, insert },
    selection: {
      anchor: offer.end - (offer.to - offer.from) + insert.length,
    },
    annotations: isolateHistory.of("full"),
    userEvent: "input.compare",
    effects: setOffer.of(null),
  });
  view.focus();
}

function dismiss(view: EditorView) {
  // Focus moves arrive in the middle of DOM work CodeMirror may itself be
  // doing; dispatching from inside it would throw.
  queueMicrotask(() => {
    if (view.state.field(offerField, false)) {
      view.dispatch({ effects: setOffer.of(null) });
    }
  });
}

function toolbarOf(view: EditorView): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(".cm-image-pair-offer");
}

function createOfferToolbar(view: EditorView): TooltipView {
  const dom = createToolbarDom("cm-image-pair-offer", "Image pair");
  const button = toolbarButton("");
  button.tabIndex = 0;
  dom.append(button);
  const sync = () => {
    const offer = view.state.field(offerField, false);
    if (offer) button.textContent = offer.label;
  };
  wireToolbar(view, dom, {
    onReturn: () => {
      const offer = view.state.field(offerField, false);
      view.focus();
      if (offer) view.dispatch({ selection: { anchor: offer.end } });
    },
    onDismiss: () => dismiss(view),
  });
  button.addEventListener("click", () => join(view));
  sync();
  return { dom, update: sync };
}

const pairTheme = EditorView.theme({
  ".cm-image-pair-arrow": {
    color: "var(--diff-addition)",
    fontWeight: "600",
  },
});

/** The green arrow of a recognised pair, and the offer to make one. */
export function imagePairs(): Extension {
  return [
    offerField,
    arrowPlugin,
    toolbarTheme,
    pairTheme,
    Prec.highest(
      keymap.of([
        {
          // Only while the offer is up; otherwise Escape is still the
          // editor's cancel.
          key: "Escape",
          run: (view) => {
            if (!view.state.field(offerField, false)) return false;
            view.dispatch({ effects: setOffer.of(null) });
            return true;
          },
        },
      ]),
    ),
    keymap.of([
      {
        key: "Mod-.",
        run: (view) => {
          if (!view.state.field(offerField, false)) return false;
          toolbarOf(view)?.querySelector<HTMLElement>("button")?.focus();
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      blur: (event, view) => {
        const next = event.relatedTarget as Node | null;
        if (next !== null && toolbarOf(view)?.contains(next)) return false;
        dismiss(view);
        return false;
      },
    }),
  ];
}
