import { splitIssueRefs } from "@/lib/issue-refs.ts";

/**
 * Minimal structural mdast shape — typed locally so we don't have to add
 * @types/mdast (react-markdown keeps it a transitive dep under pnpm).
 */
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

/**
 * Node types whose subtree must never be linkified: code by requirement
 * (#6), links because nesting an anchor inside an anchor is invalid HTML.
 * `code` and `inlineCode` are leaves without children, but listing them
 * documents the exemption where a reader looks for it.
 */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference"]);

/**
 * remark plugin: turn #N tokens in text into links the MarkdownView `a`
 * renderer recognises by their `#issue-N` fragment href and upgrades to
 * <IssueLink>. Operating on the AST (not the source) is what exempts code
 * blocks and inline code — their text lives in opaque leaf nodes.
 */
export function remarkIssueRefs() {
  return (tree: MdNode) => visit(tree);
}

function visit(node: MdNode): void {
  if (node.children === undefined || OPAQUE.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const segments = splitIssueRefs(child.value);
      if (segments.some((s) => s.type === "ref")) {
        for (const segment of segments) {
          next.push(
            segment.type === "text"
              ? { type: "text", value: segment.value }
              : {
                  type: "link",
                  url: `#issue-${segment.number}`,
                  children: [{ type: "text", value: segment.text }],
                },
          );
        }
        continue;
      }
    }
    visit(child);
    next.push(child);
  }
  node.children = next;
}
