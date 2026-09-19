/**
 * Shared syntax predicate for plain editor commands and completion sources.
 * Keeping it here avoids pulling completion queries into the editor's module graph.
 */

/**
 * Both predicates share literal nodes so changes cannot silently make one
 * source accept code or comments that another rejects. Ref/mention/command
 * completion also excludes raw HTML; tag templates must remain available there.
 */
const LITERAL_NODES: Record<string, true> = {
  CodeText: true,
  CodeBlock: true,
  FencedCode: true,
  InlineCode: true,
  CodeMark: true,
  CommentBlock: true,
  Comment: true,
};

const RAW_HTML_NODES: Record<string, true> = {
  HTMLBlock: true,
  HTMLTag: true,
};

type SyntaxNode = { name: string; parent: SyntaxNode | null };

type SyntaxTree = { resolveInner: (pos: number, side: -1) => SyntaxNode };

/** Resolve and walk the ancestors once, including HTML only when requested. */
function inContext(
  tree: SyntaxTree,
  pos: number,
  includeRawHtml: boolean,
): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    if (
      Object.hasOwn(LITERAL_NODES, node.name) ||
      (includeRawHtml && Object.hasOwn(RAW_HTML_NODES, node.name))
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

export function inLiteralContext(tree: SyntaxTree, pos: number): boolean {
  return inContext(tree, pos, false);
}

export function inCodeContext(tree: SyntaxTree, pos: number): boolean {
  return inContext(tree, pos, true);
}
