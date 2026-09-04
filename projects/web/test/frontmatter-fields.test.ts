import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  FRONTMATTER_FLAVOURS,
  type FrontmatterField,
  frontmatterFields,
  remarkFrontmatterTable,
} from "../src/lib/remark-frontmatter-table.ts";

/** The pipeline as `MarkdownView` and `buildSegmentIndex` both run it. */
const withPlugins = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, FRONTMATTER_FLAVOURS)
  .use(remarkFrontmatterTable);

/** The same pipeline without this card's two plugins, i.e. today's behaviour. */
const asBefore = unified().use(remarkParse).use(remarkGfm);

function treeOf(source: string): Root {
  return withPlugins.runSync(withPlugins.parse(source), source);
}

/** Node types at the top level, which is where a frontmatter block lives. */
const topTypes = (tree: Root): string[] =>
  tree.children.map((child) => child.type);

/** The same document as it parsed before this card. `asBefore` has no
 * transformers, so parsing is the whole of running it. */
const before = (source: string): Root => asBefore.parse(source);

/** Just the recognition step: what `remark-frontmatter` alone sees. */
const recognised = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFrontmatter, FRONTMATTER_FLAVOURS);

function frontmatterNode(source: string) {
  return (recognised.parse(source) as Root).children.find(
    (child) => child.type === "yaml" || child.type === "toml",
  );
}

/** Fields of the one block in `source`, cut the way the plugin cuts them. */
function fieldsOf(source: string, sep = ":"): FrontmatterField[] {
  const node = frontmatterNode(source);
  if (node?.position === undefined)
    throw new Error("no frontmatter recognised");
  return frontmatterFields(source, node.position, sep);
}

/** Each field as the pair of verbatim source slices it points at. */
function slicesOf(source: string, sep = ":"): Array<[string | null, string]> {
  return fieldsOf(source, sep).map((field) => [
    field.key === null ? null : source.slice(field.key.start, field.key.end),
    source.slice(field.value.start, field.value.end),
  ]);
}

describe("frontmatter recognition", () => {
  it("takes a YAML block at the very top, fences and all", () => {
    const source = "---\ntitle: A\nstatus: draft\n---\n\nBody here.\n";
    const node = frontmatterNode(source);
    expect(node?.type).toBe("yaml");
    // The position covers both fences, which is the range a wholly-new block
    // is highlighted over and a removed one is quoted from.
    expect(
      source.slice(node?.position?.start.offset, node?.position?.end.offset),
    ).toBe("---\ntitle: A\nstatus: draft\n---");
  });

  it("takes an empty block, and a TOML one", () => {
    expect(frontmatterNode("---\n---\n\nBody.\n")?.type).toBe("yaml");
    expect(frontmatterNode('+++\ntitle = "A"\n+++\n\nBody.\n')?.type).toBe(
      "toml",
    );
  });

  it("keeps a blank line inside the block rather than ending it", () => {
    const node = frontmatterNode("---\ntitle: A\n\nstatus: b\n---\n\nBody.\n");
    expect(node?.type).toBe("yaml");
    expect(node?.position?.end.line).toBe(5);
  });

  // The fallback guard: the four shapes `remark-frontmatter` does not
  // recognise must render exactly as they do today, which is what keeps this
  // card's blast radius inside the fence rules themselves.
  const unrecognised: Array<[string, string]> = [
    ["a leading blank line", "\n---\ntitle: A\n---\n\nBody.\n"],
    ["no closing fence", "---\ntitle: A\n\nBody.\n"],
    ["`...` as the closing fence", "---\ntitle: A\n...\n\nBody.\n"],
    ["a block mid-document", "Intro.\n\n---\ntitle: A\n---\n\nBody.\n"],
  ];

  for (const [name, source] of unrecognised) {
    it(`leaves ${name} alone`, () => {
      expect(frontmatterNode(source)).toBeUndefined();
      expect(topTypes(treeOf(source))).toEqual(topTypes(before(source)));
    });
  }
});

describe("frontmatterFields", () => {
  it("cuts one field per line, key and value each verbatim", () => {
    expect(slicesOf("---\ntitle: A\nstatus: draft\n---\n")).toEqual([
      ["title", "A"],
      ["status", "draft"],
    ]);
  });

  it("gives the whole value to the first separator", () => {
    // The second colon belongs to the URL, not to a second field.
    expect(slicesOf("---\nurl: https://x.test/a:b\n---\n")).toEqual([
      ["url", "https://x.test/a:b"],
    ]);
  });

  it("folds an indented continuation into the value above it", () => {
    const source = "---\nmeta:\n  nested: 1\n  other: 2\ntitle: A\n---\n";
    expect(slicesOf(source)).toEqual([
      ["meta", "\n  nested: 1\n  other: 2"],
      ["title", "A"],
    ]);
    // The value's line range grows with it, so the wash and the annotation
    // anchor cover every line the field occupies.
    const [meta] = fieldsOf(source);
    expect([meta?.line, meta?.endLine]).toEqual([2, 4]);
  });

  it("folds a line with no separator at all into the value above it", () => {
    expect(slicesOf("---\nnote: one\nplain continuation\n---\n")).toEqual([
      ["note", "one\nplain continuation"],
    ]);
  });

  it("takes whitespace before the separator as a continuation, not a key", () => {
    expect(slicesOf("---\nnote: one\ntwo words: three\n---\n")).toEqual([
      ["note", "one\ntwo words: three"],
    ]);
  });

  it("makes the lines ahead of the first field one keyless field", () => {
    expect(slicesOf("---\nleading\nmore\ntitle: A\n---\n")).toEqual([
      [null, "leading\nmore"],
      ["title", "A"],
    ]);
  });

  it("gives a TOML section header a keyless row of its own", () => {
    expect(slicesOf('+++\n[owner]\nname = "bot-one"\n+++\n', "=")).toEqual([
      [null, "[owner]"],
      ["name", '"bot-one"'],
    ]);
  });

  it("keeps an empty value as an empty range", () => {
    expect(slicesOf("---\ntitle:\nstatus: draft\n---\n")).toEqual([
      ["title", ""],
      ["status", "draft"],
    ]);
  });

  it("finds no field in an empty block", () => {
    expect(fieldsOf("---\n---\n")).toEqual([]);
  });

  it("reads a block holding one blank line as a single keyless field", () => {
    expect(slicesOf("---\n\n---\n")).toEqual([[null, ""]]);
  });

  it("points every key and value at its own source slice", () => {
    const source = "---\ntitle: A\nmeta:\n  nested: 1\n---\n\nBody.\n";
    for (const field of fieldsOf(source)) {
      if (field.key !== null) {
        expect(source.slice(field.key.start, field.key.end)).not.toContain(
          "\n",
        );
      }
      // Half-open and inside the block, which is what keeps `exact` true in
      // the index and lets a word-level mark land inside a value.
      expect(field.value.start).toBeLessThanOrEqual(field.value.end);
      expect(field.value.end).toBeLessThanOrEqual(source.length);
    }
  });
});

describe("remarkFrontmatterTable", () => {
  it("builds a two-column table whose cells are verbatim slices", () => {
    const source = "---\ntitle: A\nstatus: draft\n---\n\nBody.\n";
    const tree = treeOf(source);
    const block = tree.children[0];
    expect(block?.type).toBe("frontmatter");
    if (block?.type !== "frontmatter") return;
    const body = block.children[0];
    expect(body?.type).toBe("frontmatterBody");
    const rows = body?.children ?? [];
    expect(rows.map((row) => row.children.map((c) => c.type))).toEqual([
      ["frontmatterKey", "frontmatterValue"],
      ["frontmatterKey", "frontmatterValue"],
    ]);
    for (const row of rows) {
      for (const c of row.children) {
        const text = c.children[0];
        if (text === undefined) continue;
        expect(
          source.slice(c.position?.start.offset, c.position?.end.offset),
        ).toBe(text.value);
      }
    }
  });

  it("covers the whole block, both fences, with the table's own position", () => {
    const source = "---\ntitle: A\n---\n\nBody.\n";
    const block = treeOf(source).children[0];
    expect(
      source.slice(block?.position?.start.offset, block?.position?.end.offset),
    ).toBe("---\ntitle: A\n---");
  });

  it("drops an empty block entirely, <hr>s and all", () => {
    expect(topTypes(treeOf("---\n---\n\nBody.\n"))).toEqual(["paragraph"]);
  });

  it("sends no text child for an empty cell", () => {
    const block = treeOf("---\ntitle:\n---\n");
    const row =
      block.children[0]?.type === "frontmatter"
        ? block.children[0].children[0]?.children[0]
        : undefined;
    expect(row?.children.map((c) => c.children.length)).toEqual([1, 0]);
  });

  it("gives a keyless field both cells, so the table stays two wide", () => {
    // Width comes from the first row (`tableOf` in spec-source-index), so a
    // keyless field leading the block must not narrow it to one column.
    const tree = treeOf("---\nleading\ntitle: A\n---\n");
    const block = tree.children[0];
    if (block?.type !== "frontmatter") throw new Error("no frontmatter");
    expect(
      block.children[0]?.children.map((row) => row.children.length),
    ).toEqual([2, 2]);
  });
});
