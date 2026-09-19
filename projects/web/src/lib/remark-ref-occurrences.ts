import { parseInternalHref } from "@todou/shared";

/**
 * Minimal structural mdast shape — typed locally so we don't have to add
 * @types/mdast (react-markdown keeps it a transitive dep under pnpm).
 */
type MdNode = {
  type: string;
  url?: string;
  data?: { hProperties?: Record<string, string> };
  children?: MdNode[];
};

/** Set on every reference to a card this document has already named. */
export const REF_REPEAT_ATTR = "data-ref-repeat";

/** The href shapes remarkIssueRefs emits (see refHref). */
const ISSUE_REF_HREF = /^#issue-(\d{1,9})(?:\/comment-\d{1,9})?$/;
const XREF_HREF =
  /^#xref-([a-z0-9][a-z0-9-]*)\/(\d{1,9})(?:\/comment-\d{1,9})?$/;
const XREF_COMMENT_HREF = /^#xref-comment-(\d{1,9})$/;

/**
 * Which card a link names. The comment id is deliberately not part of it: an
 * issue link and a comment link to the same card are the same target, so the
 * second one keeps its full reference and author, losing only the title.
 *
 * A stored reference spells its project as an id and a written one as a slug,
 * and translating between them needs the viewer's project directory, which a
 * parse-time plugin has no access to. Both spellings of one card therefore
 * count as two.
 */
function cardKey(url: string | undefined): string | null {
  if (url === undefined) return null;
  const ref = ISSUE_REF_HREF.exec(url);
  if (ref !== null) return `here/${ref[1]}`;
  const xref = XREF_HREF.exec(url);
  if (xref !== null) return `slug:${xref[1]}/${xref[2]}`;
  // Which card carries a bare `#comment-M` is a lookup away, so it can only
  // be deduplicated against the same id written again.
  const bare = XREF_COMMENT_HREF.exec(url);
  if (bare !== null) return `comment:${bare[1]}`;
  const target = parseInternalHref(url, globalThis.location?.origin);
  if (target === null || target.kind !== "issue") return null;
  return target.project.kind === "slug"
    ? `slug:${target.project.slug}/${target.number}`
    : `id:${target.project.id}/${target.number}`;
}

/**
 * Mark every reference after a card's first appearance in this document.
 *
 * Syntax-tree order is document order, which is what makes "first" mean the
 * same thing on every render: a renderer-side counter would answer to React's
 * mount order, to StrictMode's double render, and to any remount.
 *
 * The mark is written whatever the reader prefers — one traversal — so that
 * flipping the preference re-renders without re-parsing.
 */
export function remarkRefOccurrences() {
  return (tree: MdNode) => {
    const seen = new Set<string>();
    const walk = (node: MdNode) => {
      if (node.type === "link") {
        const key = cardKey(node.url);
        if (key !== null) {
          if (seen.has(key)) {
            node.data ??= {};
            node.data.hProperties = {
              ...node.data.hProperties,
              [REF_REPEAT_ATTR]: "true",
            };
          } else {
            seen.add(key);
          }
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}
