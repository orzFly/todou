import type { AlignType, List, Nodes, Table, TableRow } from "mdast";
import { parseMarkdown } from "./markdown-processor.ts";

/** A half-open source span and what replaces it. */
type Edit = { start: number; end: number; text: string };

type Span = { start: number; end: number };

/**
 * Nodes that hold nothing but prose and the structure around it. Everything
 * else — a code span, raw HTML, a link's destination and title, frontmatter —
 * carries its own bytes to the page, so whitespace inside one is content and
 * the rules below stay out of it. Being a whitelist is the point: a node type
 * nobody here has thought about is left alone rather than rewritten.
 */
const TRANSPARENT = new Set([
  "root",
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "footnoteDefinition",
  "text",
  "break",
]);

/**
 * Leads every token, because a document cannot contain it: a token colliding
 * with prose would report two different sources as one.
 */
const TOKEN = "\0";

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function overlaps(span: Span, start: number, end: number): boolean {
  return span.start < end && span.end > start;
}

/**
 * End of a list item's marker, the whitespace up to its content included;
 * null when the source does not read as a marker at all.
 *
 * Whitespace running to the end of the line is left to the trailing-space
 * rule, and five or more of it indents the content into a code block — which
 * CommonMark reaches by consuming a single space, so one is all we consume.
 */
function markerEnd(
  source: string,
  start: number,
  ordered: boolean,
): number | null {
  let at = start;
  if (ordered) {
    while (at < source.length && /[0-9]/.test(source[at] ?? "")) at++;
    if (at === start) return null;
    const delimiter = source[at];
    if (delimiter !== "." && delimiter !== ")") return null;
    at++;
  } else {
    const bullet = source[at];
    if (bullet !== "-" && bullet !== "*" && bullet !== "+") return null;
    at++;
  }
  let spaced = at;
  while (spaced < source.length && /[ \t]/.test(source[spaced] ?? "")) spaced++;
  if (spaced === at) return at;
  if (spaced >= source.length || source[spaced] === "\n") return at;
  return spaced - at > 4 ? at + 1 : spaced;
}

/**
 * A list marker carries exactly two things onto the page: `<ol start>`, read
 * from the first item alone, and where one list ends and the next begins. So
 * the first item keeps its number while every later one loses its own, and the
 * two positions take different tokens — a list split in two grows a second
 * first item, and that is the difference a reader can see.
 */
function listEdits(list: List, source: string): Edit[] {
  const ordered = list.ordered === true;
  const edits: Edit[] = [];
  list.children.forEach((item, index) => {
    const start = item.position?.start.offset;
    if (start === undefined) return;
    const end = markerEnd(source, start, ordered);
    if (end === null) return;
    const first = index === 0;
    const text = ordered
      ? first
        ? `${TOKEN}ol:${list.start ?? 1}`
        : `${TOKEN}ol`
      : first
        ? `${TOKEN}ul`
        : `${TOKEN}ul-`;
    edits.push({ start, end, text });
  });
  return edits;
}

/**
 * A row rewritten as `|a|b|`. The cell boundaries come from the parse, so an
 * escaped `\|` stays inside the cell it was written in, and a row written
 * without its outer pipes canonicalises to what one written with them gives.
 */
function rowEdit(row: TableRow, source: string): Edit | null {
  const start = row.position?.start.offset;
  const end = row.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  if (row.position?.start.line !== row.position?.end.line) return null;
  const cells: string[] = [];
  for (const cell of row.children) {
    const from = cell.position?.start.offset;
    const to = cell.position?.end.offset;
    if (from === undefined || to === undefined) return null;
    let text = source.slice(from, to);
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);
    cells.push(text.trim());
  }
  return { start, end, text: `|${cells.join("|")}|` };
}

function alignMark(align: AlignType): string {
  if (align === "left") return ":-";
  if (align === "right") return "-:";
  if (align === "center") return ":-:";
  return "-";
}

/**
 * The delimiter row has no node of its own, so it is found as the line under
 * the header and rewritten from `table.align`, the only part of it the parser
 * kept. It is taken from the column the header row starts at, which leaves a
 * `> ` or an indent in front of it alone: moving a table into a blockquote
 * does change the rendering, and shows up on that prefix alone.
 */
function delimiterEdit(
  table: Table,
  source: string,
  lineStarts: number[],
): Edit | null {
  const header = table.children[0]?.position;
  if (header === undefined) return null;
  const line = header.end.line + 1;
  if (line > (table.position?.end.line ?? 0)) return null;
  const lineStart = lineStarts[line - 1];
  const headerLineStart = lineStarts[header.start.line - 1];
  const headerStart = header.start.offset;
  if (
    lineStart === undefined ||
    headerLineStart === undefined ||
    headerStart === undefined
  ) {
    return null;
  }
  const lineEnd = (lineStarts[line] ?? source.length + 1) - 1;
  const start = lineStart + (headerStart - headerLineStart);
  if (start > lineEnd) return null;
  if (!/^[|\-: \t]*-[|\-: \t]*$/.test(source.slice(start, lineEnd)))
    return null;
  const marks = (table.children[0]?.children ?? []).map((_, column) =>
    alignMark(table.align?.[column] ?? null),
  );
  return { start, end: lineEnd, text: `|${marks.join("|")}|` };
}

/**
 * Trailing whitespace reaches the page only as a hard break, so a run one of
 * those covers is levelled to two spaces and the rest are dropped. A run
 * inside an opaque span is neither: it is content that happens to sit at the
 * end of a line.
 */
function trailingSpaceEdits(
  source: string,
  lineStarts: number[],
  breaks: Span[],
  opaque: Span[],
): Edit[] {
  const edits: Edit[] = [];
  for (let line = 1; line <= lineStarts.length; line++) {
    const lineStart = lineStarts[line - 1];
    if (lineStart === undefined) continue;
    const lineEnd = (lineStarts[line] ?? source.length + 1) - 1;
    let start = lineEnd;
    while (start > lineStart && /[ \t]/.test(source[start - 1] ?? "")) start--;
    if (start === lineEnd) continue;
    const hard = breaks.some((span) => overlaps(span, start, lineEnd));
    if (!hard && opaque.some((span) => overlaps(span, start, lineEnd)))
      continue;
    const text = hard ? "  " : "";
    if (source.slice(start, lineEnd) !== text) {
      edits.push({ start, end: lineEnd, text });
    }
  }
  return edits;
}

/** Earlier edits win: an overlapping later one is dropped rather than nested. */
function applyEdits(source: string, edits: Edit[]): string {
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let at = 0;
  for (const edit of edits) {
    if (edit.start < at) continue;
    out += source.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + source.slice(at);
}

function countLines(source: string): number {
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lines++;
  }
  return lines;
}

function collect(source: string, lineStarts: number[]): Edit[] {
  const structural: Edit[] = [];
  const breaks: Span[] = [];
  const opaque: Span[] = [];

  const visit = (node: Nodes): void => {
    const position = node.position;
    if (!TRANSPARENT.has(node.type)) {
      if (position !== undefined) {
        opaque.push({
          start: position.start.offset ?? 0,
          end: position.end.offset ?? 0,
        });
      }
      return;
    }
    if (node.type === "break" && position !== undefined) {
      breaks.push({
        start: position.start.offset ?? 0,
        end: position.end.offset ?? 0,
      });
    }
    if (node.type === "list") structural.push(...listEdits(node, source));
    if (node.type === "table") {
      for (const row of node.children) {
        const edit = rowEdit(row, source);
        if (edit !== null) structural.push(edit);
      }
      const edit = delimiterEdit(node, source, lineStarts);
      if (edit !== null) structural.push(edit);
    }
    if (!("children" in node)) return;
    for (const child of node.children) visit(child);
  };

  visit(parseMarkdown(source));
  return [
    ...structural,
    ...trailingSpaceEdits(source, lineStarts, breaks, opaque),
  ];
}

/**
 * `source` with the bytes the parser discards replaced by fixed tokens, for
 * comparison only — the result is never parsed again and never rendered, so it
 * does not have to be legal markdown.
 *
 * The line count is preserved, which is what lets a diff of two canonical
 * texts report line numbers of the originals. A rule that broke it would shift
 * every range below it by the same amount, which no caller can tell from a
 * genuine edit, so the count is checked here and the original returned on a
 * mismatch.
 */
export function canonicalForDiff(source: string): string {
  const lineStarts = lineStartsOf(source);
  const canonical = applyEdits(source, collect(source, lineStarts));
  return countLines(canonical) === lineStarts.length ? canonical : source;
}
