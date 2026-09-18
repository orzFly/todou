import type { Element, RootContent } from "hast";
import { describe, expect, it } from "vitest";
import {
  CODE_CONTENT_START_ATTR,
  SOURCE_LINE_ATTR,
} from "../src/lib/rehype-source-lines.ts";
import {
  buildBaselineTree,
  extractBaselineNode,
} from "../src/lib/spec-baseline-tree.ts";
import {
  buildSegmentIndex,
  type SourceBlockType,
} from "../src/lib/spec-source-index.ts";

function elementChildren(node: Element): Element[] {
  return node.children.filter((child) => child.type === "element");
}

function blockOf(source: string, type: SourceBlockType) {
  const block = buildSegmentIndex(source).blocks.find(
    (candidate) => candidate.type === type,
  );
  if (block === undefined) throw new Error(`no ${type} block`);
  return block;
}

function extracted(source: string, type: SourceBlockType): Element {
  const node = extractBaselineNode(
    buildBaselineTree(source),
    blockOf(source, type),
  );
  if (node === null) throw new Error(`no ${type} baseline node`);
  return node;
}

function descendants(node: RootContent): RootContent[] {
  return node.type === "element"
    ? [node, ...node.children.flatMap(descendants)]
    : [node];
}

describe("spec baseline HAST", () => {
  it("looks up the semantic element for every structural block shape", () => {
    const cases: Array<[SourceBlockType, string, string]> = [
      ["paragraph", "body\n", "p"],
      ["heading", "## title\n", "h2"],
      ["list", "- item\n", "ul"],
      ["listItem", "- item\n", "li"],
      ["blockquote", "> quote\n", "blockquote"],
      ["code", "```ts\nconst n = 1;\n```\n", "pre"],
      ["table", "| a | b |\n| - | - |\n| 1 | 2 |\n", "table"],
      ["tableRow", "| a | b |\n| - | - |\n| 1 | 2 |\n", "tr"],
      ["tableCell", "| a | b |\n| - | - |\n| 1 | 2 |\n", "th"],
      ["frontmatter", "---\ntitle: old\n---\n", "table"],
      ["tableRow", "---\ntitle: old\n---\n", "tr"],
      ["tableCell", "---\ntitle: old\n---\n", "th"],
    ];

    for (const [type, source, tagName] of cases) {
      const node = extracted(source, type);
      expect(node.tagName, type).toBe(tagName);
      expect(node.position, type).toBeUndefined();
    }
    expect(
      extracted("---\ntitle: old\n---\n", "frontmatter").properties.className,
    ).toContain("markdown-frontmatter");
  });

  it("resolves links and images from definitions in the complete old document", () => {
    const source = [
      "[old link][target]",
      "",
      "![old image][picture]",
      "",
      "[target]: https://example.test/old",
      "[picture]: https://example.test/old.png",
      "",
    ].join("\n");
    const baseline = buildBaselineTree(source);
    const paragraphs = buildSegmentIndex(source).blocks.filter(
      (block) => block.type === "paragraph",
    );
    if (paragraphs[0] === undefined || paragraphs[1] === undefined) {
      throw new Error("reference paragraphs were not indexed");
    }

    const paragraph = extractBaselineNode(baseline, paragraphs[0]);
    const imageParagraph = extractBaselineNode(baseline, paragraphs[1]);
    expect(elementChildren(paragraph as Element)[0]).toMatchObject({
      tagName: "a",
      properties: { href: "https://example.test/old" },
    });
    expect(elementChildren(imageParagraph as Element)[0]).toMatchObject({
      tagName: "img",
      properties: {
        alt: "old image",
        src: "https://example.test/old.png",
      },
    });
  });

  it("locates inline images as standalone semantic blocks", () => {
    const source = "before ![old](https://example.test/old.png) after\n";
    expect(extracted(source, "image")).toMatchObject({
      tagName: "img",
      properties: { alt: "old", src: "https://example.test/old.png" },
    });
  });

  it("keeps rejected URLs and arbitrary raw HTML non-executable", () => {
    const source =
      "[bad](javascript:alert(1))\n\n> <script>alert('no')</script>\n";
    const baseline = buildBaselineTree(source);
    const elements = baseline.tree.children.filter(
      (child): child is Element => child.type === "element",
    );
    expect(elements.some((node) => node.tagName === "a")).toBe(false);
    expect(elements.some((node) => node.tagName === "script")).toBe(false);
    expect(elements[0]?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          value: "[bad](javascript:alert(1))",
        }),
      ]),
    );
    const blockquote = extractBaselineNode(
      baseline,
      blockOf(source, "blockquote"),
    );
    expect(descendants(blockquote as Element)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "raw",
          value: "<script>alert('no')</script>",
        }),
      ]),
    );
  });

  it("applies only the restricted details conversion", () => {
    const source =
      "<details>\n<summary>Old summary</summary>\n\nOld body.\n\n</details>\n";
    const baseline = buildBaselineTree(source);
    const details = baseline.tree.children.find(
      (child): child is Element =>
        child.type === "element" && child.tagName === "details",
    );
    expect(details).toBeDefined();
    expect(elementChildren(details as Element)[0]?.tagName).toBe("summary");
    expect(descendants(details as Element)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "Old summary" }),
        expect.objectContaining({ value: "Old body." }),
      ]),
    );
  });

  it("returns fresh metadata-free clones without consuming the original", () => {
    const source = "A [link](https://example.test).\n";
    const baseline = buildBaselineTree(source);
    const block = blockOf(source, "paragraph");
    const original = baseline.nodes.values().next().value;
    if (original === undefined) throw new Error("no indexed original");
    original.properties[SOURCE_LINE_ATTR] = "1-1";
    original.properties[CODE_CONTENT_START_ATTR] = 1;
    const nested = elementChildren(original)[0];
    if (nested === undefined) throw new Error("no nested link");
    nested.properties[SOURCE_LINE_ATTR] = "1-1";

    const first = extractBaselineNode(baseline, block);
    const second = extractBaselineNode(baseline, block);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(
      descendants(first as Element).every((node) => {
        if (node.position !== undefined) return false;
        if (node.type !== "element") return true;
        return (
          node.properties[SOURCE_LINE_ATTR] === undefined &&
          node.properties[CODE_CONTENT_START_ATTR] === undefined
        );
      }),
    ).toBe(true);

    expect(original.position).toBeDefined();
    expect(original.properties[SOURCE_LINE_ATTR]).toBe("1-1");
    expect(nested.position).toBeDefined();
    expect(nested.properties[SOURCE_LINE_ATTR]).toBe("1-1");
    expect(extractBaselineNode(baseline, block)).toEqual(first);
  });
});
