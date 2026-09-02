import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { LineRange } from "./spec-changes.ts";

/**
 * Blocks that hold phrasing content directly. Everything between two of
 * them renders as a break — two paragraphs, a heading and its body, two
 * table cells — so the flattened text puts a newline there and a word
 * never straddles the boundary. Emphasis, links and the like are NOT on
 * this list: `a **b** c` is one flow and reads as "a b c".
 *
 * A fence is a leaf too and owns a group of its own (T-211), but it holds
 * no prose and so is handled apart from these: its group never reaches the
 * flattened text.
 */
const LEAF_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

/**
 * Structure the whole-block insertion evidence can name (T-158). `code` is
 * on the list, and since T-211 it is a leaf like any other: its whole source
 * — fences included — is the text it aligns by, so a fence being added or
 * removed is decided the same way a paragraph is, and a container holding
 * one can be judged new or gone in its entirety.
 */
const SOURCE_BLOCKS = new Set([
  "paragraph",
  "heading",
  "tableCell",
  "tableRow",
  "table",
  "listItem",
  "list",
  "blockquote",
  "code",
]);

const processor = unified().use(remarkParse).use(remarkGfm);

/** One run of prose, with both of its coordinate systems. */
export type SourceSegment = {
  /** The rendered text: entities decoded, markdown syntax already gone. */
  text: string;
  /** Offset of `text[0]` within `SegmentIndex.text`. */
  at: number;
  /** The markdown this came from, as absolute `[start, end)` offsets. */
  start: number;
  end: number;
  line: number;
  endLine: number;
  /**
   * The source span reads character-for-character like `text`, so an
   * offset inside one maps to the other by addition. False for inline
   * code (its backticks are in the span but not the value), escapes and
   * entities — those segments are indivisible and get located whole.
   */
  exact: boolean;
  /** Which leaf block this flows in; a different one means a break. */
  group: number;
};

export type SourceBlockType =
  | "paragraph"
  | "heading"
  | "tableCell"
  | "tableRow"
  | "table"
  | "listItem"
  | "list"
  | "blockquote"
  | "code";

/** One block of structure, for deciding what counts as "new whole" (T-158). */
export type SourceBlock = {
  type: SourceBlockType;
  /** Absolute source offsets, half-open. */
  start: number;
  end: number;
  /** 1-based inclusive source lines. */
  line: number;
  endLine: number;
  /** Index into `SegmentIndex.blocks`; null at the top level. */
  parent: number | null;
  /** Leaf-block groups this subtree owns, inclusive; -1 when it owns none. */
  firstGroup: number;
  lastGroup: number;
  /**
   * The subtree holds raw HTML. Coverage then says nothing about the block
   * as a whole — content nothing ever aligned would be declared new on the
   * strength of the text around it. A fence used to count here too; since
   * T-211 it owns a leaf group and can speak for itself.
   */
  opaque: boolean;
};

export type SegmentIndex = {
  source: string;
  /** All prose in document order, leaf blocks separated by newlines. */
  text: string;
  segments: SourceSegment[];
  /** Absolute offset each 1-based source line starts at. */
  lineStarts: number[];
  /** Block structure in document order: a parent always precedes its children. */
  blocks: SourceBlock[];
  /** The leaf block each group came from, indexed by group number. */
  groupTypes: SourceBlockType[];
};

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Index a markdown source for the decoration engine (T-142): what prose it
 * contains, and where each run of it lives in the source. Both directions
 * are needed — source offsets in, to place a word-diff range on the page;
 * rendered offsets in, to turn a reader's selection into an anchor.
 *
 * Fenced and indented code is deliberately absent from the prose: those
 * blocks are handed to pierre's CodeView as plain text (T-31), and injecting
 * anything into them would corrupt the extraction. They keep block-level
 * treatment, and own a leaf group so the alignment can still place them.
 */
export function buildSegmentIndex(source: string): SegmentIndex {
  const segments: SourceSegment[] = [];
  const blocks: SourceBlock[] = [];
  const groupTypes: SourceBlockType[] = [];
  let text = "";
  let groups = 0;
  let group = -1;
  let lastGroup: number | null = null;
  let parent: number | null = null;

  const pushBlock = (node: Nodes, type: SourceBlockType): number | null => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return null;
    blocks.push({
      type,
      start,
      end,
      line: node.position?.start.line ?? 1,
      endLine: node.position?.end.line ?? 1,
      parent,
      firstGroup: -1,
      lastGroup: -1,
      opaque: false,
    });
    return blocks.length - 1;
  };

  const markOpaque = (): void => {
    for (let i = parent; i !== null; ) {
      const block = blocks[i];
      if (block === undefined) return;
      block.opaque = true;
      i = block.parent;
    }
  };

  const visit = (node: Nodes): void => {
    if (node.type === "html") {
      markOpaque();
      return;
    }
    // A fence is a leaf that owns a group but contributes no prose: nothing
    // enters `text` or `segments`, so annotation anchoring and selection
    // mapping never see it, while the alignment gets a block it can pair,
    // insert or remove whole (T-211).
    if (node.type === "code") {
      const index = pushBlock(node, "code");
      if (index === null) return;
      const own = groups++;
      groupTypes[own] = "code";
      const block = blocks[index];
      if (block !== undefined) {
        block.firstGroup = own;
        block.lastGroup = own;
      }
      return;
    }
    if (node.type === "text" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      if (node.value === "") return;
      if (lastGroup !== null && lastGroup !== group) text += "\n";
      segments.push({
        text: node.value,
        at: text.length,
        start,
        end,
        line: node.position?.start.line ?? 1,
        endLine: node.position?.end.line ?? 1,
        exact: end - start === node.value.length,
        group,
      });
      text += node.value;
      lastGroup = group;
      return;
    }
    if (!("children" in node)) return;
    const outerGroup = group;
    const outerParent = parent;
    const index = SOURCE_BLOCKS.has(node.type)
      ? pushBlock(node, node.type as SourceBlockType)
      : null;
    if (index !== null) parent = index;
    const firstGroup = groups;
    if (LEAF_BLOCKS.has(node.type)) {
      group = groups++;
      groupTypes[group] = node.type as SourceBlockType;
    }
    for (const child of node.children) visit(child);
    const block = index === null ? undefined : blocks[index];
    if (block !== undefined && groups > firstGroup) {
      block.firstGroup = firstGroup;
      block.lastGroup = groups - 1;
    }
    group = outerGroup;
    parent = outerParent;
  };

  visit(processor.parse(source));
  return {
    source,
    text,
    segments,
    lineStarts: lineStartsOf(source),
    blocks,
    groupTypes,
  };
}

/** Segments whose source span touches a 1-based inclusive line range. */
export function segmentsInLines(
  index: SegmentIndex,
  range: LineRange,
): SourceSegment[] {
  return index.segments.filter(
    (s) => s.line <= range.end && s.endLine >= range.start,
  );
}

export type SourceRange = { start: number; end: number };

/**
 * Source offsets covered by `[from, to)` of the flattened text, clipped to
 * one range per segment. Clipping is the point: the markdown *between*
 * segments — `**`, `|`, the newline joining two cells — is never part of
 * the answer, so a highlight can't leak onto syntax or onto a neighbouring
 * table cell that didn't change.
 */
export function sourceRangesOfText(
  index: SegmentIndex,
  from: number,
  to: number,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const segment of index.segments) {
    const segEnd = segment.at + segment.text.length;
    if (segEnd <= from) continue;
    if (segment.at >= to) break;
    const localFrom = Math.max(from, segment.at) - segment.at;
    const localTo = Math.min(to, segEnd) - segment.at;
    if (localTo <= localFrom) continue;
    const range = segment.exact
      ? { start: segment.start + localFrom, end: segment.start + localTo }
      : { start: segment.start, end: segment.end };
    const last = ranges.at(-1);
    if (last !== undefined && last.end >= range.start) {
      last.end = Math.max(last.end, range.end);
    } else {
      ranges.push(range);
    }
  }
  return ranges;
}

/** Flattened-text extent of each leaf group; holes where a group has no prose. */
function groupRangesOf(index: SegmentIndex): Array<SourceRange | undefined> {
  const ranges: Array<SourceRange | undefined> = [];
  for (const segment of index.segments) {
    const end = segment.at + segment.text.length;
    const existing = ranges[segment.group];
    if (existing === undefined) {
      ranges[segment.group] = { start: segment.at, end };
    } else existing.end = end;
  }
  return ranges;
}

/** Blocks with no qualifying ancestor, i.e. the outermost of each nest. */
function outermost(index: SegmentIndex, qualifies: boolean[]): SourceBlock[] {
  return index.blocks.filter((block, i) => {
    if (qualifies[i] !== true) return false;
    for (let p = block.parent; p !== null; ) {
      if (qualifies[p] === true) return false;
      p = index.blocks[p]?.parent ?? null;
    }
    return true;
  });
}

/**
 * Outermost blocks every one of whose leaf groups is in `groups`. This is the
 * evidence the alignment carries (T-163): a group nothing on the old side
 * matched is new, and a block built only out of such groups was born whole.
 *
 * Groups holding no prose abstain rather than veto — an empty table cell says
 * nothing about whether its table is new. A fence's group is the exception it
 * used to be part of: it holds no prose either, but it is a leaf that was
 * aligned, so it votes, and that is what lets a list item carrying a code
 * block be taken or given up in one piece (T-211).
 */
export function blocksWhollyInGroups(
  index: SegmentIndex,
  groups: ReadonlySet<number>,
): SourceBlock[] {
  const groupRanges = groupRangesOf(index);
  const qualifies = index.blocks.map((block) => {
    if (block.opaque || block.firstGroup < 0) return false;
    let any = false;
    for (let g = block.firstGroup; g <= block.lastGroup; g++) {
      if (index.groupTypes[g] !== "code" && groupRanges[g] === undefined) {
        continue;
      }
      if (!groups.has(g)) return false;
      any = true;
    }
    return any;
  });
  return outermost(index, qualifies);
}

/**
 * The outermost block a leaf group sits in; null when no block owns it.
 * Blocks sharing a group are always nested and a parent always precedes its
 * children, so the first match in document order is the top of that nest.
 */
export function outermostBlockOfGroup(
  index: SegmentIndex,
  group: number,
): SourceBlock | null {
  return (
    index.blocks.find(
      (block) =>
        block.firstGroup >= 0 &&
        block.firstGroup <= group &&
        block.lastGroup >= group,
    ) ?? null
  );
}

/** Source offset for a caret sitting at `pos` in the flattened text. */
export function sourceOffsetOfText(
  index: SegmentIndex,
  pos: number,
): number | null {
  for (const segment of index.segments) {
    const segEnd = segment.at + segment.text.length;
    if (pos < segment.at || pos > segEnd) continue;
    if (!segment.exact) return pos === segEnd ? segment.end : segment.start;
    return segment.start + (pos - segment.at);
  }
  return null;
}

/**
 * Map an offset into a block's *rendered* text onto a source offset. The
 * DOM has no separator between leaf blocks — `textContent` of a table row
 * is just its cells run together — so this walks segment lengths rather
 * than reading `SegmentIndex.text`.
 *
 * A non-exact segment can't be entered: an offset inside one collapses to
 * whichever of its edges the caller is looking for.
 */
export function sourceOffsetOfRendered(
  segments: SourceSegment[],
  offset: number,
  edge: "start" | "end",
): number | null {
  let seen = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) continue;
    const next = seen + segment.text.length;
    // On a boundary the two sides disagree about who owns the offset: a
    // selection's start reaches forward into the next segment, its end
    // back into this one. The last segment owns its own far edge.
    const owns =
      offset < next ||
      (offset === next && (edge === "end" || i === segments.length - 1));
    if (owns) {
      if (!segment.exact) return edge === "start" ? segment.start : segment.end;
      return segment.start + (offset - seen);
    }
    seen = next;
  }
  return null;
}

/** 1-based line and UTF-16 code-unit column of a source offset. */
export function lineColAt(
  index: SegmentIndex,
  offset: number,
): { line: number; col: number } {
  let low = 0;
  let high = index.lineStarts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((index.lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, col: offset - (index.lineStarts[low] ?? 0) + 1 };
}

/** Inverse of `lineColAt`; null when the position is off the end. */
export function offsetAt(
  index: SegmentIndex,
  line: number,
  col: number,
): number | null {
  const start = index.lineStarts[line - 1];
  if (start === undefined) return null;
  const nextLine = index.lineStarts[line];
  const end = nextLine === undefined ? index.source.length : nextLine - 1;
  const offset = start + col - 1;
  return offset > end ? null : offset;
}
