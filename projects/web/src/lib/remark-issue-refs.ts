import {
  DEFAULT_REF_CONFIG,
  type RefConfig,
  type RefSegment,
  splitIssueRefs,
} from "@/lib/issue-refs.ts";

type Point = { line: number; column: number; offset: number };

/**
 * Minimal structural mdast shape — typed locally so we don't have to add
 * @types/mdast (react-markdown keeps it a transitive dep under pnpm).
 */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  data?: { hProperties?: Record<string, string> };
  position?: { start: Point; end: Point };
  children?: MdNode[];
};

/**
 * Node types whose subtree must never be linkified: code by requirement
 * (T-6), links because nesting an anchor inside an anchor is invalid HTML.
 * `code` and `inlineCode` are leaves without children, but listing them
 * documents the exemption where a reader looks for it.
 *
 * `frontmatter` is here because it is the one entry that is not self-enforcing
 * (T-240). A `yaml` node has no children and so was exempt by accident; the
 * table `remarkFrontmatterTable` puts in its place has `text` children, and
 * metadata is not prose — `related: F-1` in a frontmatter value would be
 * replaced by another card's title, which is the half of that card's bug that
 * matters. Naming the container makes the whole subtree exit early whatever
 * order the plugins run in; relying on this one running first would be an
 * implicit constraint the next person to touch that array cannot see.
 */
const OPAQUE = new Set([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "frontmatter",
]);

/**
 * The fragment hrefs MarkdownLink recognises. A fragment rather than a
 * real path because the destination is only knowable after a lookup the
 * renderer does — an <a href> written here would be a promise the link
 * cannot always keep.
 */
export function refHref(segment: RefSegment): string {
  switch (segment.type) {
    case "ref":
      return segment.commentId === undefined
        ? `#issue-${segment.number}`
        : `#issue-${segment.number}/comment-${segment.commentId}`;
    case "xref":
      return segment.commentId === undefined
        ? `#xref-${segment.slug}/${segment.number}`
        : `#xref-${segment.slug}/${segment.number}/comment-${segment.commentId}`;
    case "comment":
      return `#xref-comment-${segment.commentId}`;
    default:
      return "";
  }
}

/**
 * remark plugin: turn reference tokens in text into links. Reference
 * tokens become links the MarkdownView `a` renderer recognises by their
 * fragment href and upgrades to <IssueLink>; autolink tokens become plain
 * external links. Operating on the AST (not the source) is what exempts
 * code blocks and inline code — their text lives in opaque leaf nodes.
 * Config is per-content (T-80 time cutoff); pass it via the remark options
 * tuple: `[remarkIssueRefs, config]`.
 */
export function remarkIssueRefs(config: RefConfig = DEFAULT_REF_CONFIG) {
  return (tree: MdNode) => visit(tree, config);
}

function visit(node: MdNode, config: RefConfig): void {
  if (node.children === undefined || OPAQUE.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const segments = splitIssueRefs(child.value, config);
      if (segments.some((s) => s.type !== "text")) {
        next.push(...split(child, segments));
        continue;
      }
    }
    visit(child, config);
    next.push(child);
  }
  node.children = next;
}

/** The point `text` characters past `from`, counting the lines it crosses. */
function advance(from: Point, text: string): Point {
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  return {
    line: from.line + lines.length - 1,
    column: lines.length > 1 ? last.length + 1 : from.column + text.length,
    offset: from.offset + text.length,
  };
}

/**
 * Replace one text node with its segments, each carrying the source span it
 * came from. The spans are what the decoration engine paints annotations
 * and word-level diffs onto (T-142/T-164): pieces without one are skipped
 * outright, so a single ref used to cost a whole paragraph its highlight.
 *
 * Offsets inside the node only mean something when the source span and the
 * value agree character for character. Entities, escapes and a list item's
 * continuation indent all stretch the span, and then every segment claims
 * the whole node instead — which the engine reads as "indivisible" and
 * highlights in one go, the same fallback inline code has always taken.
 */
function split(node: MdNode, segments: RefSegment[]): MdNode[] {
  const span = node.position;
  const exact =
    span !== undefined &&
    span.end.offset - span.start.offset === (node.value ?? "").length;
  let cursor = exact ? span?.start : undefined;
  const out: MdNode[] = [];
  for (const segment of segments) {
    let position = span;
    if (cursor !== undefined) {
      const end = advance(
        cursor,
        segment.type === "text" ? segment.value : segment.text,
      );
      position = { start: cursor, end };
      cursor = end;
    }
    out.push(nodeFor(segment, position));
  }
  return out;
}

function nodeFor(segment: RefSegment, position: MdNode["position"]): MdNode {
  if (segment.type === "text") {
    return { type: "text", value: segment.value, position };
  }
  // The link's own text stays position-less: IssueLink throws these
  // children away and renders the fetched title in their place, so a
  // decoration painted inside would land on something nobody ever sees.
  const children = [{ type: "text", value: segment.text }];
  return segment.type === "ext"
    ? {
        type: "link",
        url: segment.href,
        title: segment.href,
        data: { hProperties: { target: "_blank", rel: "noreferrer" } },
        children,
        position,
      }
    : { type: "link", url: refHref(segment), children, position };
}
