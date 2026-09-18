/**
 * Shared syntax predicate for plain editor commands and completion sources.
 * Keeping it here avoids pulling completion queries into the editor's module graph.
 */

/** Node names @lezer/markdown gives code, where the grammar reads no refs. */
const CODE_NODES = new Set([
  "CodeText",
  "CodeBlock",
  "FencedCode",
  "InlineCode",
  "CodeMark",
  "CommentBlock",
  "Comment",
  "HTMLBlock",
  "HTMLTag",
]);

type SyntaxNode = { name: string; parent: SyntaxNode | null };

export function inCodeContext(
  tree: { resolveInner: (pos: number, side: -1) => SyntaxNode },
  pos: number,
): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    if (CODE_NODES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}
