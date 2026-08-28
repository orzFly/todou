import {
  DEFAULT_REF_CONFIG,
  type RefConfig,
  type RefSegment,
  splitIssueRefs,
} from "@/lib/issue-refs.ts";

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
  children?: MdNode[];
};

/**
 * Node types whose subtree must never be linkified: code by requirement
 * (T-6), links because nesting an anchor inside an anchor is invalid HTML.
 * `code` and `inlineCode` are leaves without children, but listing them
 * documents the exemption where a reader looks for it.
 */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference"]);

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
        for (const segment of segments) {
          next.push(
            segment.type === "text"
              ? { type: "text", value: segment.value }
              : segment.type === "ext"
                ? {
                    type: "link",
                    url: segment.href,
                    title: segment.href,
                    data: {
                      hProperties: { target: "_blank", rel: "noreferrer" },
                    },
                    children: [{ type: "text", value: segment.text }],
                  }
                : {
                    type: "link",
                    url: refHref(segment),
                    children: [{ type: "text", value: segment.text }],
                  },
          );
        }
        continue;
      }
    }
    visit(child, config);
    next.push(child);
  }
  node.children = next;
}
