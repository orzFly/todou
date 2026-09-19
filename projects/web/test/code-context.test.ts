import { GFM, parser } from "@lezer/markdown";
import { describe, expect, it, vi } from "vitest";
import {
  inCodeContext,
  inLiteralContext,
} from "../src/lib/editor/code-context.ts";

const markdownParser = parser.configure([GFM]);

type Node = { name: string; parent: Node | null };

function treeOf(names: string[]) {
  let node: Node = { name: "Document", parent: null };
  for (const name of names) node = { name, parent: node };
  return { resolveInner: vi.fn(() => node) };
}

describe("shared syntax context membership", () => {
  // Each literal entry is tested separately: deleting either comment kind,
  // or a code node hidden by an ancestor in real trees, must fail here.
  it.each([
    "CodeText",
    "CodeBlock",
    "FencedCode",
    "InlineCode",
    "CodeMark",
    "CommentBlock",
    "Comment",
  ])("both predicates reject a %s ancestor", (name) => {
    const tree = treeOf([name, "Leaf"]);
    expect(inCodeContext(tree, 7)).toBe(true);
    expect(inLiteralContext(tree, 7)).toBe(true);
  });

  it.each(["HTMLBlock", "HTMLTag"])(
    "only inCodeContext rejects a %s ancestor",
    (name) => {
      const tree = treeOf([name, "Leaf"]);
      expect(inCodeContext(tree, 7)).toBe(true);
      expect(inLiteralContext(tree, 7)).toBe(false);
    },
  );

  it.each(["Paragraph", "Text", "constructor", "toString"])(
    "neither predicate rejects ordinary or unknown node %s",
    (name) => {
      const tree = treeOf([name]);
      expect(inCodeContext(tree, 7)).toBe(false);
      expect(inLiteralContext(tree, 7)).toBe(false);
    },
  );

  it.each([inCodeContext, inLiteralContext])(
    "%s resolves once, biased toward the text before the caret",
    (predicate) => {
      const tree = treeOf(["Paragraph"]);
      expect(predicate(tree, 7)).toBe(false);
      expect(tree.resolveInner).toHaveBeenCalledExactlyOnceWith(7, -1);
    },
  );
});

describe("real Markdown syntax boundaries", () => {
  // The caret marker is removed before parsing; no syntaxTree mock is used.
  // Checking the actual ancestor name keeps these fixtures honest about which
  // parser branch, and which node-set mutation, they exercise.
  it.each([
    ["unfinished details", "<details¦", "HTMLBlock", true, false],
    ["next HTML line", "<details>\n<¦", "HTMLBlock", true, false],
    ["summary prefix", "<details>\n<summary¦", "HTMLBlock", true, false],
    ["inline HTML", "text <details¦> tail", "HTMLTag", true, false],
    ["HTML tag end", "text <details>¦ tail", "HTMLTag", true, false],
    ["after HTML tag", "text <details> ¦tail", "Paragraph", false, false],
    ["HTML to prose", "<details>\n\ntext¦", "Paragraph", false, false],
    ["fenced code", "```\n<¦\n```", "FencedCode", true, true],
    ["open fence", "```\n<¦", "FencedCode", true, true],
    ["list fence", "- item\n\n  ```\n  <¦\n  ```", "FencedCode", true, true],
    ["space code", "    <¦", "CodeBlock", true, true],
    ["tab code", "\t<¦", "CodeBlock", true, true],
    ["inline code", "text `x¦`", "InlineCode", true, true],
    ["inline code end", "text `x`¦", "InlineCode", true, true],
    ["after inline code", "text `x` ¦tail", "Paragraph", false, false],
    ["block comment", "<!-- <¦ -->", "CommentBlock", true, true],
    ["open block comment", "<!--\n<¦", "CommentBlock", true, true],
    ["multiline comment", "<!--\n<¦\n-->", "CommentBlock", true, true],
    ["inline comment", "text <!-- x¦ -->", "Comment", true, true],
    ["comment end", "text <!-- x -->¦", "Comment", true, true],
    ["after comment", "text <!-- x --> ¦tail", "Paragraph", false, false],
    ["comment to prose", "<!-- x -->\n\ntext¦", "Paragraph", false, false],
    ["fence to prose", "```\nx\n```\n\ntext¦", "Paragraph", false, false],
    ["ordinary prose", "text¦", "Paragraph", false, false],
    ["empty document", "¦", "Document", false, false],
  ])("%s", (_name, marked, expectedNode, code, literal) => {
    const pos = marked.indexOf("¦");
    const tree = markdownParser.parse(marked.replace("¦", ""));
    const ancestors: string[] = [];
    let node: Node | null = tree.resolveInner(pos, -1);
    while (node !== null) {
      ancestors.push(node.name);
      node = node.parent;
    }
    expect(ancestors).toContain(expectedNode);
    expect(inCodeContext(tree, pos)).toBe(code);
    expect(inLiteralContext(tree, pos)).toBe(literal);
  });
});
