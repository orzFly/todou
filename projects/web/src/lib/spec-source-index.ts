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
 */
const LEAF_BLOCKS = new Set(["paragraph", "heading", "tableCell"]);

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

export type SegmentIndex = {
  source: string;
  /** All prose in document order, leaf blocks separated by newlines. */
  text: string;
  segments: SourceSegment[];
  /** Absolute offset each 1-based source line starts at. */
  lineStarts: number[];
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
 * Fenced and indented code is deliberately absent: those blocks are handed
 * to pierre's CodeView as plain text (T-31), and injecting anything into
 * them would corrupt the extraction. They keep block-level treatment.
 */
export function buildSegmentIndex(source: string): SegmentIndex {
  const segments: SourceSegment[] = [];
  let text = "";
  let groups = 0;
  let group = -1;
  let lastGroup: number | null = null;

  const visit = (node: Nodes): void => {
    if (node.type === "code" || node.type === "html") return;
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
    const outer = group;
    if (LEAF_BLOCKS.has(node.type)) group = groups++;
    for (const child of node.children) visit(child);
    group = outer;
  };

  visit(processor.parse(source));
  return { source, text, segments, lineStarts: lineStartsOf(source) };
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

/** The `SegmentIndex.text` range a run of segments occupies. */
export function textRangeOf(
  segments: SourceSegment[],
): { start: number; end: number } | null {
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) return null;
  return { start: first.at, end: last.at + last.text.length };
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

/** How many leaf blocks a flattened-text range reaches across. */
export function groupSpanOfText(
  index: SegmentIndex,
  from: number,
  to: number,
): number {
  const groups = new Set<number>();
  for (const segment of index.segments) {
    const segEnd = segment.at + segment.text.length;
    if (segEnd <= from) continue;
    if (segment.at >= to) break;
    groups.add(segment.group);
  }
  return groups.size;
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
