import type { Element, ElementContent, Root } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  MARKDOWN_SYNTAX_PLUGINS,
  MESSAGE_SYNTAX_PLUGINS,
} from "../src/lib/markdown-processor.ts";

function hast(markdown: string, syntax: PluggableList): Root {
  const processor = unified().use(remarkParse).use(syntax).use(remarkRehype);
  return processor.runSync(processor.parse(markdown), markdown) as Root;
}

function firstParagraph(tree: Root): Element {
  const p = tree.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "p",
  );
  if (p === undefined) throw new Error("no paragraph");
  return p;
}

function breaks(node: Root | Element): Element[] {
  const found: Element[] = [];
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "br") found.push(child);
    found.push(...breaks(child));
  }
  return found;
}

const shape = (children: ElementContent[]) =>
  children.map((c) => (c.type === "element" ? c.tagName : c.type));

describe("single newlines (T-702)", () => {
  it("are a break in a message and a newline in a document", () => {
    const message = firstParagraph(hast("a\nb", MESSAGE_SYNTAX_PLUGINS));
    // mdast-util-to-hast follows every `<br>` with a newline text node.
    expect(shape(message.children).filter((t) => t !== "text")).toEqual(["br"]);
    expect(message.children[0]).toMatchObject({ type: "text", value: "a" });
    expect(message.children.at(-1)).toMatchObject({
      type: "text",
      value: "b",
    });

    const document = firstParagraph(hast("a\nb", MARKDOWN_SYNTAX_PLUGINS));
    expect(document.children).toHaveLength(1);
    expect(document.children[0]).toMatchObject({
      type: "text",
      value: "a\nb",
    });
  });

  it.each([
    ["message", MESSAGE_SYNTAX_PLUGINS],
    ["document", MARKDOWN_SYNTAX_PLUGINS],
  ] as const)("a hard break is one break in a %s", (_, syntax) => {
    expect(breaks(hast("a  \nb", syntax))).toHaveLength(1);
  });

  it("leave code alone", () => {
    expect(breaks(hast("```\na\nb\n```\n", MESSAGE_SYNTAX_PLUGINS))).toEqual(
      [],
    );
    expect(breaks(hast("`a\nb`\n", MESSAGE_SYNTAX_PLUGINS))).toEqual([]);
  });

  it("make breaks with no position, unlike a hard break", () => {
    const [soft] = breaks(hast("a\nb", MESSAGE_SYNTAX_PLUGINS));
    expect(soft.position).toBeUndefined();
    const [hard] = breaks(hast("a  \nb", MESSAGE_SYNTAX_PLUGINS));
    expect(hard.position).toBeDefined();
  });
});
