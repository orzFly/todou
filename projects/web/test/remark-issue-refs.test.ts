import type { Nodes, Paragraph, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import type { RefConfig } from "../src/lib/issue-refs.ts";
import { remarkIssueRefs } from "../src/lib/remark-issue-refs.ts";

const CONFIG: RefConfig = { internalPrefix: "T", autolinks: [] };

const plain = unified().use(remarkParse).use(remarkGfm);
const linkified = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkIssueRefs, CONFIG);

const parse = (source: string): Root =>
  linkified.runSync(linkified.parse(source)) as Root;

/** The paragraph inside the first block, tight list items included. */
function firstParagraph(tree: Root): Paragraph {
  const found = find(tree as Nodes);
  if (found === null) throw new Error("no paragraph in the tree");
  return found;
}

function find(node: Nodes): Paragraph | null {
  if (node.type === "paragraph") return node;
  if (!("children" in node)) return null;
  for (const child of node.children) {
    const found = find(child);
    if (found !== null) return found;
  }
  return null;
}

const spanOf = (node: Nodes) => [
  node.position?.start.offset,
  node.position?.end.offset,
];

// T-164: the split used to drop position entirely, and the decoration
// engine skips anything without one — so a single ref cost its whole
// paragraph every annotation highlight and word-level mark it had.
describe("remarkIssueRefs keeps the source span on every piece", () => {
  const SOURCE = "见 T-161 的做法。\n";

  it("tiles the original span exactly when source and value agree", () => {
    const children = firstParagraph(parse(SOURCE)).children;
    expect(children.map((child) => child.type)).toEqual([
      "text",
      "link",
      "text",
    ]);
    // "见 " | "T-161" | " 的做法。", laid end to end over the whole node.
    expect(children.map(spanOf)).toEqual([
      [0, 2],
      [2, 7],
      [7, 12],
    ]);
    expect(children.map((child) => child.position?.start.column)).toEqual([
      1, 3, 8,
    ]);
  });

  it("leaves the link's own text position-less", () => {
    const link = firstParagraph(parse(SOURCE)).children[1];
    if (link?.type !== "link") throw new Error("no link");
    expect(link.url).toBe("#issue-161");
    expect(link.children[0]?.position).toBeUndefined();
  });

  it("carries line and column across a soft break", () => {
    const children = firstParagraph(parse("甲\n乙 T-9 丙\n")).children;
    const link = children[1];
    expect(link?.position?.start).toMatchObject({ line: 2, column: 3 });
    expect(link?.position?.end).toMatchObject({ line: 2, column: 6 });
  });

  it("gives every piece the whole node when the two disagree", () => {
    // A continuation indent stretches the source span past the value, so
    // no offset counted inside the value can be trusted.
    const source = "- 见 T-161，\n  换行继续。\n";
    const original = firstParagraph(plain.runSync(plain.parse(source)) as Root);
    const children = firstParagraph(parse(source)).children;
    expect(original.children).toHaveLength(1);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(spanOf(child)).toEqual(spanOf(original.children[0] as Nodes));
    }
  });

  it("adds no position where the node had none", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "见 T-161。" }],
        },
      ],
    };
    remarkIssueRefs(CONFIG)(tree);
    const children = (
      tree.children[0] as { children: Array<{ position?: unknown }> }
    ).children;
    expect(children).toHaveLength(3);
    for (const child of children) expect(child.position).toBeUndefined();
  });
});
