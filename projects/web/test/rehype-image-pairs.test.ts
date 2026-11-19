import type { Element, Root } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import type { PluggableList } from "unified";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  MARKDOWN_SYNTAX_PLUGINS,
  MESSAGE_SYNTAX_PLUGINS,
} from "../src/lib/markdown-processor.ts";
import { pairLabel, rehypeImagePairs } from "../src/lib/rehype-image-pairs.ts";
import { IMAGE_PAIR_CASES } from "./image-pair-cases.ts";

function hast(
  markdown: string,
  syntax: PluggableList = MARKDOWN_SYNTAX_PLUGINS,
): Root {
  const processor = unified()
    .use(remarkParse)
    .use(syntax)
    .use(remarkRehype)
    .use(rehypeImagePairs);
  return processor.runSync(processor.parse(markdown), markdown) as Root;
}

function images(node: Root | Element): Element[] {
  const found: Element[] = [];
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "img") found.push(child);
    found.push(...images(child));
  }
  return found;
}

describe("rehypeImagePairs", () => {
  // A message turns its single newlines into breaks (T-702); the pair rule
  // gives both kinds of text one answer.
  const SYNTAXES = [
    { syntax: "document", plugins: MARKDOWN_SYNTAX_PLUGINS },
    { syntax: "message", plugins: MESSAGE_SYNTAX_PLUGINS },
  ];
  it.each(
    SYNTAXES.flatMap((s) => IMAGE_PAIR_CASES.map((c) => ({ ...s, ...c }))),
  )("$syntax: $name → pair: $pair", ({ markdown, pair, plugins }) => {
    const paired = images(hast(markdown, plugins)).some(
      (img) => img.properties.dataComparePair !== undefined,
    );
    expect(paired).toBe(pair);
  });

  it("leaves the second image alone in the paragraph, carrying the first", () => {
    const markdown = "Intro.\n\n![old](/a.png) -> ![new](/b.png)\n";
    const tree = hast(markdown);
    const p = tree.children.filter(
      (c): c is Element => c.type === "element" && c.tagName === "p",
    )[1];
    expect(p.children).toHaveLength(1);
    const img = p.children[0] as Element;
    expect(img.properties.src).toBe("/b.png");
    expect(img.properties.dataSwapSrc).toBe("/a.png");
    expect(img.properties.dataSwapAlt).toBe("old");
    expect(img.properties.dataComparePair).toBe("");
    expect(img.properties.dataPairBeforeAt).toBe(String("Intro.\n\n".length));
    expect(img.properties.className).toContain("spec-img-compare");
    expect(img.position?.start.offset).toBe(markdown.indexOf("![new]"));
  });

  it("leaves everything else as it was", () => {
    const tree = hast("see ![a](/x.png) → ![b](/y.png) here\n");
    expect(images(tree)).toHaveLength(2);
    expect(
      images(tree).every((img) => img.properties.dataSwapSrc === undefined),
    ).toBe(true);
  });
});

describe("pairLabel", () => {
  const src = "/api/projects/p/attachments/7/download/shot%201.png";

  it("is the alt an author wrote", () => {
    expect(pairLabel(" master ", src, "Before")).toBe("master");
  });

  it("falls back when the alt is empty", () => {
    expect(pairLabel("  ", src, "Before")).toBe("Before");
  });

  it("falls back when the alt is the attachment's file name", () => {
    expect(pairLabel("shot 1", "/x/shot 1", "After")).toBe("After");
    expect(pairLabel("shot 1.png", src, "After")).toBe("After");
  });

  it("falls back when the alt is a plain address's last segment", () => {
    expect(pairLabel("hero", "https://example.com/img/hero", "After")).toBe(
      "After",
    );
  });

  it("falls back when the alt ends in an image extension", () => {
    expect(pairLabel("Screenshot.JPEG", "/x/y", "Before")).toBe("Before");
  });
});
