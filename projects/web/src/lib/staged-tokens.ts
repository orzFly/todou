/**
 * Placeholders for files staged in an editor but not yet uploaded. A file
 * goes into the text as `![name](staged:<key>)` (or `[name](staged:<key>)`
 * for a non-image) where the reader put it, and sending swaps each one for
 * the attachment's real address — so the text alone says which files go out
 * and where they sit.
 *
 * Only an image or link node whose destination is exactly `staged:<key>`,
 * for a key the editor staged, counts: the same characters inside code,
 * inside HTML, or with a key nobody staged are ordinary text.
 */

import { parser as commonmarkParser, GFM } from "@lezer/markdown";
import {
  attachmentImageMarker,
  attachmentLinkMarker,
  escapeLinkText,
} from "@/lib/attachment-refs.ts";

/** The configuration `MarkdownEditor` highlights with, so both read alike. */
const gfmParser = commonmarkParser.configure([GFM]);

/** @lezer/common's node, which this package does not depend on by name. */
type SyntaxNode = ReturnType<
  ReturnType<typeof gfmParser.parse>["resolveInner"]
>;

/**
 * `staged:<n>-<tag>`: `n` reads as which file of its editor it is, and the
 * random tag tells it apart from another editor's, tab's or visit's `n`.
 */
const STAGED_URL = /^staged:(\d+-[a-z0-9]+)$/;

/** Cheap pre-check: a text without it holds no placeholder. */
const STAGED_MARK = "](staged:";

/**
 * The type a drag out of a staging tray carries besides the token as text,
 * naming the page and the file, so an editor can take the file itself
 * rather than a link to nothing, and an editor that stages no files can
 * refuse it.
 */
export const STAGED_TOKEN_TYPE = "application/x-todou-staged-token";

export type StagedTokenRange = {
  from: number;
  to: number;
  key: string;
  /** The link text, between the opening bracket and `]`. */
  labelFrom: number;
  labelTo: number;
  /**
   * The token with the space on each side of it, where there is one: what
   * the caret steps over and what goes as one. A space between two tokens
   * belongs to the first.
   */
  unitFrom: number;
  unitTo: number;
};

type Candidate = Omit<StagedTokenRange, "unitFrom" | "unitTo">;

/** Which file of its editor `key` names: the `n` of `<n>-<tag>`. */
export function stagedOrdinal(key: string): number {
  return Number.parseInt(key, 10);
}

export function stagedToken(
  key: string,
  filename: string,
  image: boolean,
): string {
  const url = `staged:${key}`;
  return image
    ? attachmentImageMarker(filename, url)
    : attachmentLinkMarker(filename, url);
}

/**
 * The key an image or link node points at, if it is a placeholder. The
 * destination is the URL after `](`: GFM also finds one in link text that
 * reads like an address, a file named `www.example.com.png` for one.
 */
function placeholderKey(
  node: SyntaxNode,
  text: string,
  labelTo: number,
): string | null {
  const url = node.getChildren("URL").find((child) => child.from > labelTo);
  if (url === undefined) return null;
  const match = STAGED_URL.exec(text.slice(url.from, url.to));
  return match?.[1] ?? null;
}

/**
 * The last text parsed and every `staged:` image or link in it, whatever
 * its key. One keystroke asks about the same text several times — the
 * edit filter about the old one, then the chips and the tray about the new
 * one — and a long description is not worth parsing three times over.
 */
let parsed: { text: string; candidates: Candidate[] } | null = null;

function candidatesIn(text: string): Candidate[] {
  if (parsed?.text === text) return parsed.candidates;
  const candidates: Candidate[] = [];
  gfmParser.parse(text).iterate({
    enter: (ref) => {
      if (ref.name !== "Image" && ref.name !== "Link") return;
      const node = ref.node;
      const marks = node.getChildren("LinkMark");
      const open = marks[0];
      const close = marks[1];
      if (open === undefined || close === undefined) return;
      const key = placeholderKey(node, text, close.from);
      if (key === null) return;
      candidates.push({
        from: node.from,
        to: node.to,
        key,
        labelFrom: open.to,
        labelTo: close.from,
      });
    },
  });
  parsed = { text, candidates };
  return candidates;
}

/**
 * Every placeholder in `text`, in order. `known` says whether a key is one
 * the editor staged. A placeholder is not searched for placeholders inside
 * it, so the ranges never overlap, and neither do their units.
 */
export function stagedTokenRanges(
  text: string,
  known: (key: string) => boolean,
): StagedTokenRange[] {
  if (!text.includes(STAGED_MARK)) return [];
  const ranges: StagedTokenRange[] = [];
  // In document order, an outer node before the ones inside it.
  for (const candidate of candidatesIn(text)) {
    if (!known(candidate.key)) continue;
    const last = ranges.at(-1);
    if (last !== undefined && candidate.from < last.to) continue;
    const { from, to } = candidate;
    const unitFrom =
      text[from - 1] === " " && from - 1 >= (last?.unitTo ?? 0)
        ? from - 1
        : from;
    const unitTo = text[to] === " " ? to + 1 : to;
    ranges.push({ ...candidate, unitFrom, unitTo });
  }
  return ranges;
}

/** The keys `text` places, in order of first appearance. */
export function stagedKeysIn(
  text: string,
  known: (key: string) => boolean,
): string[] {
  return [...new Set(stagedTokenRanges(text, known).map((r) => r.key))];
}

/**
 * Structures a placeholder cannot sit on any line of: code would hide it,
 * an HTML block would swallow it, and a link definition, a rule or a setext
 * heading's underline would stop being one. It goes after the whole block,
 * as a paragraph of its own.
 */
const BLOCKS = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "LinkReference",
  "HorizontalRule",
  "SetextHeading1",
  "SetextHeading2",
]);

/**
 * What opens a line before its text, a table row's leading pipe included:
 * a token in front of one would turn it into text.
 */
const LINE_MARKS = new Set([
  "QuoteMark",
  "ListMark",
  "HeaderMark",
  "TaskMarker",
  "TableDelimiter",
]);

/** Inline structures a placeholder cannot split; it goes after them. */
const INLINES = new Set([
  "InlineCode",
  "Link",
  "Image",
  "HTMLTag",
  "Comment",
  "Autolink",
  "URL",
]);

function lineStart(doc: string, pos: number): number {
  return doc.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(doc: string, pos: number): number {
  const at = doc.indexOf("\n", pos);
  return at === -1 ? doc.length : at;
}

type Placement =
  /** `inside`: `pos` was inside a structure the token must not split. */
  | { kind: "inline"; at: number; inside: boolean; prefix: string }
  | { kind: "block"; from: number; to: number; prefix: string };

/**
 * What a line needs in front to stay inside the quotes and list items
 * around `node`: `> ` per quote, and a list item's text indent per item.
 */
function containerPrefix(node: SyntaxNode | null, doc: string): string {
  let prefix = "";
  for (let at = node; at !== null; at = at.parent) {
    if (at.name === "Blockquote") prefix = `> ${prefix}`;
    if (at.name === "ListItem") {
      const mark = at.getChild("ListMark");
      if (mark === null) continue;
      let text = mark.to;
      while (doc[text] === " ") text += 1;
      // Past four spaces the text is indented code, and the item's own
      // indent is the mark and one space.
      const gap = text - mark.to;
      const width = mark.to - mark.from + (gap >= 1 && gap <= 4 ? gap : 1);
      prefix = `${" ".repeat(width)}${prefix}`;
    }
  }
  return prefix;
}

/** Where a line's text starts, past its indent and quote, list or heading marks. */
function textStart(
  tree: ReturnType<typeof gfmParser.parse>,
  doc: string,
  start: number,
  end: number,
): number {
  let at = start;
  for (;;) {
    while (at < end && (doc[at] === " " || doc[at] === "\t")) at += 1;
    let mark: SyntaxNode | null = null;
    for (
      let node: SyntaxNode | null = tree.resolveInner(at, 1);
      node !== null;
      node = node.parent
    ) {
      if (LINE_MARKS.has(node.name) && node.from === at) mark = node;
    }
    if (mark === null || mark.to <= at) return at;
    at = mark.to;
  }
}

/**
 * Where an insertion at `pos` actually lands: past the outermost block
 * whose lines it falls on, else past the outermost inline structure it is
 * strictly inside, else right there.
 */
function placement(doc: string, pos: number): Placement {
  const tree = gfmParser.parse(doc);
  // Any position on the block's lines, not only inside the node: at a
  // fence's edge, or in an indented block's indent, the token would still
  // join the block's line.
  const start = lineStart(doc, pos);
  const end = lineEnd(doc, pos);
  let block: SyntaxNode | null = null;
  const take = (node: SyntaxNode) => {
    if (block === null || node.from < block.from) block = node;
  };
  tree.iterate({
    from: start,
    to: end,
    enter: (ref) => {
      // A table's delimiter row: text on it unmakes the table.
      const table = ref.node.parent;
      if (ref.name === "TableDelimiter" && table?.name === "Table") {
        if (ref.to - ref.from > 1) take(table);
        return;
      }
      if (!BLOCKS.has(ref.name)) return;
      if (ref.to >= start && ref.from <= end) take(ref.node);
      return false;
    },
  });
  // The blank line right after an HTML block: text there continues the
  // block, which runs on to the next blank line.
  if (block === null && start > 0 && doc.slice(start, end).trim() === "") {
    tree.iterate({
      from: start - 1,
      to: start - 1,
      enter: (ref) => {
        if (ref.name !== "HTMLBlock") return;
        if (lineEnd(doc, ref.to) === start - 1) take(ref.node);
        return false;
      },
    });
  }
  if (block !== null) {
    const { from, to } = block;
    return {
      kind: "block",
      from: lineStart(doc, from),
      to: lineEnd(doc, to),
      prefix: containerPrefix(block, doc),
    };
  }
  let inline: SyntaxNode | null = null;
  // Both sides: a position on a node's edge resolves to only one of them.
  for (const side of [-1, 1] as const) {
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side);
      node !== null;
      node = node.parent
    ) {
      if (INLINES.has(node.name) && node.from < pos && pos < node.to) {
        if (inline === null || node.from < inline.from) inline = node;
      }
    }
  }
  const at =
    inline !== null
      ? inline.to
      : // Before a line's `>`, `-` or `#`, the token would push it into the text.
        Math.max(pos, textStart(tree, doc, start, end));
  return {
    kind: "inline",
    at,
    inside: inline !== null,
    prefix: containerPrefix(tree.resolveInner(at, -1), doc),
  };
}

/** Whether `pos` is inside a structure a token must not split. */
function cutsAt(doc: string, pos: number): boolean {
  const spot = placement(doc, pos);
  return spot.kind === "block" ? spot.from < pos && pos < spot.to : spot.inside;
}

function newlinesBefore(doc: string, pos: number): number {
  let count = 0;
  while (count < 2 && doc[pos - 1 - count] === "\n") count += 1;
  return count;
}

function newlinesAfter(doc: string, pos: number): number {
  let count = 0;
  while (count < 2 && doc[pos + count] === "\n") count += 1;
  return count;
}

/** Whether every token sits in `doc` as an image or link node of its own. */
function allRecognized(
  doc: string,
  at: number,
  tokens: string[],
  separator: string,
): boolean {
  const spans = new Set<string>();
  gfmParser.parse(doc).iterate({
    enter: (ref) => {
      if (ref.name === "Image" || ref.name === "Link") {
        spans.add(`${ref.from}:${ref.to}`);
      }
    },
  });
  let start = at;
  for (const token of tokens) {
    if (!spans.has(`${start}:${start + token.length}`)) return false;
    start += token.length + separator.length;
  }
  return true;
}

/**
 * The change that puts `tokens` into `doc` for a selection `from`–`to`.
 *
 * Each token goes in with a space of its own on each side, whatever is
 * next to it: the token and those spaces are one unit, which the caret
 * stops only outside of. Inline, by default. A selection is replaced unless
 * an end of it is inside code, a link or the like; then the selection stays
 * and the tokens go after its end. A position inside such an inline
 * structure moves past it, and one before a line's quote, list or heading
 * marks moves to the text after them.
 *
 * A position on the lines of a code, HTML or link-definition block, a rule,
 * a setext heading or a table's delimiter row, or on the blank line an HTML
 * block would run on into, goes past the block instead, as a paragraph of
 * its own: a blank line between tokens and on each side. If what follows
 * swallows that paragraph — an unclosed fence, say — it goes before the
 * block; and an inline token something else swallows gets the same
 * treatment beside its line.
 *
 * `cursor` is the position in the changed document to put the caret at.
 */
export function tokenInsertion(
  doc: string,
  from: number,
  to: number,
  tokens: string[],
): { from: number; to: number; insert: string; cursor: number } {
  const replace = from < to && !cutsAt(doc, from) && !cutsAt(doc, to);
  // Placed against the document as it reads once the selection is gone; the
  // change below spans from the selection's start to that spot.
  const rest = replace ? doc.slice(0, from) + doc.slice(to) : doc;
  const pos = replace ? from : to;
  const removed = replace ? to - from : 0;
  const spot = placement(rest, pos);

  const change = (
    at: number,
    insert: string,
    caret: number,
  ): { from: number; to: number; insert: string; cursor: number } => {
    // `at` is in `rest`; what lies between `pos` and `at` is kept verbatim.
    const kept = rest.slice(pos, at);
    const start = replace ? from : at;
    return {
      from: start,
      to: replace ? at + removed : at,
      insert: replace ? kept + insert : insert,
      cursor: start + (replace ? kept.length : 0) + caret,
    };
  };

  // The tokens as a paragraph after the lines `lines.from`–`lines.to`, or
  // before them if what follows would swallow it (an unclosed fence, say).
  // Inside a quote or a list item every line it adds carries `prefix`, so
  // the paragraph stays inside them.
  const paragraph = (lines: { from: number; to: number; prefix: string }) => {
    const { prefix } = lines;
    const blank = prefix.trimEnd();
    const separator = `\n${blank}\n${prefix}`;
    const body = tokens.map((token) => ` ${token} `).join(separator);
    const after = lines.to;
    let padBefore: string;
    let padAfter: string;
    if (prefix === "") {
      padBefore = "\n".repeat(2 - newlinesBefore(rest, after));
      padAfter = "\n".repeat(2 - newlinesAfter(rest, after));
    } else {
      padBefore = separator;
      padAfter = after < rest.length ? `\n${blank}` : "";
    }
    const insert = padBefore + body + padAfter;
    const result = rest.slice(0, after) + insert + rest.slice(after);
    if (
      allRecognized(
        result,
        after + padBefore.length + 1,
        tokens,
        ` ${separator} `,
      )
    ) {
      return change(after, insert, insert.length);
    }
    const before = lines.from;
    const pad =
      before === 0
        ? ""
        : prefix === ""
          ? "\n".repeat(2 - newlinesBefore(rest, before))
          : `${blank}\n`;
    return change(
      before,
      `${pad}${prefix}${body}\n${blank}\n`,
      pad.length + prefix.length + body.length,
    );
  };

  if (spot.kind === "block") return paragraph(spot);

  const at = spot.at;
  const insert = tokens.map((token) => ` ${token} `).join("");
  const result = rest.slice(0, at) + insert + rest.slice(at);
  if (allRecognized(result, at + 1, tokens, "  ")) {
    return change(at, insert, insert.length);
  }
  // Swallowed by something the rules above do not know: the tokens take a
  // paragraph of their own after the line, splitting its paragraph there if
  // they must, rather than going out as text nobody recognizes.
  return paragraph({
    from: lineStart(rest, at),
    to: lineEnd(rest, at),
    prefix: spot.prefix,
  });
}

/** Chinese, Japanese and Korean text, which runs on without spaces. */
const CJK =
  /[\p{scx=Han}\p{scx=Bopomofo}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\u3000-\u303f\uff00-\uffef]/u;

/** The code point ending at `pos`, a surrogate pair whole. */
function charBefore(text: string, pos: number): string {
  return [...text.slice(Math.max(0, pos - 2), pos)].at(-1) ?? "";
}

/** The code point starting at `pos`. */
function charAfter(text: string, pos: number): string {
  return [...text.slice(pos, pos + 2)][0] ?? "";
}

/**
 * What takes the place of `from`–`to`, one or more whole units, when they
 * go: a space where the words on each side would otherwise run together,
 * and nothing beside whitespace, an edge, or Chinese, Japanese or Korean
 * text on both sides.
 */
export function stagedUnitGap(text: string, from: number, to: number): string {
  const before = charBefore(text, from);
  const after = charAfter(text, to);
  if (before === "" || after === "") return "";
  if (/\s/.test(before) || /\s/.test(after)) return "";
  return CJK.test(before) && CJK.test(after) ? "" : " ";
}

/**
 * The changes that take every placeholder for `key` out of `text`, each
 * unit whole and units that touch as one, leaving `stagedUnitGap` behind.
 * `known` says which keys the editor staged, which decides whose unit a
 * space between two tokens is.
 */
export function stagedTokenDeletions(
  text: string,
  known: (key: string) => boolean,
  key: string,
): Array<{ from: number; to: number; insert?: string }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (const range of stagedTokenRanges(text, known)) {
    if (range.key !== key) continue;
    const last = runs.at(-1);
    if (last !== undefined && last.to === range.unitFrom) {
      last.to = range.unitTo;
    } else {
      runs.push({ from: range.unitFrom, to: range.unitTo });
    }
  }
  return runs.map(({ from, to }) => {
    const insert = stagedUnitGap(text, from, to);
    return insert === "" ? { from, to } : { from, to, insert };
  });
}

/**
 * Point each resolved key's placeholders at its upload. Link text that
 * still reads as the name the file was staged under becomes the name the
 * server settled on (T-269); text the reader rewrote stays as written.
 */
export function resolveStagedTokens(
  text: string,
  resolved: ReadonlyMap<
    string,
    { url: string; filename: string; insertedName: string }
  >,
): string {
  let out = "";
  let last = 0;
  for (const range of stagedTokenRanges(text, (key) => resolved.has(key))) {
    const target = resolved.get(range.key);
    if (target === undefined) continue;
    const label = text.slice(range.labelFrom, range.labelTo);
    const urlFrom = text.indexOf(`staged:${range.key}`, range.labelTo);
    const urlTo = urlFrom + `staged:${range.key}`.length;
    out +=
      text.slice(last, range.labelFrom) +
      (label === escapeLinkText(target.insertedName)
        ? escapeLinkText(target.filename)
        : label) +
      text.slice(range.labelTo, urlFrom) +
      target.url;
    last = urlTo;
  }
  return out + text.slice(last);
}
