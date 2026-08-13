import {
  DEFAULT_REF_CONFIG,
  type RefConfig,
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
 * remark plugin: turn reference tokens in text into links. Internal refs
 * become links the MarkdownView `a` renderer recognises by their
 * `#issue-N` fragment href and upgrades to <IssueLink>; autolink tokens
 * become plain external links. Operating on the AST (not the source) is
 * what exempts code blocks and inline code — their text lives in opaque
 * leaf nodes. Config is per-content (T-80 time cutoff); pass it via the
 * remark options tuple: `[remarkIssueRefs, config]`.
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
              : segment.type === "ref"
                ? {
                    type: "link",
                    url: `#issue-${segment.number}`,
                    children: [{ type: "text", value: segment.text }],
                  }
                : {
                    type: "link",
                    url: segment.href,
                    title: segment.href,
                    data: {
                      hProperties: { target: "_blank", rel: "noreferrer" },
                    },
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
