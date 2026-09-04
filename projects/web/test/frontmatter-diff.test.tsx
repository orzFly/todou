import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { alignGroups } from "../src/lib/group-align.ts";
import { parseSourceLoc } from "../src/lib/rehype-source-lines.ts";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { changeDecorations, leavesOf } from "../src/lib/spec-decorations.ts";
import { buildSegmentIndex } from "../src/lib/spec-source-index.ts";
import { renderWithProviders } from "./render.tsx";

// Same pin as the other spec-view tests: fences go through pierre's CodeView.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

const fm = (...fields: string[]): string =>
  `---\n${fields.join("\n")}\n---\n\nBody text.\n`;

function decorate(before: string, after: string) {
  return changeDecorations(buildSegmentIndex(before), buildSegmentIndex(after));
}

/** What the view highlights as added, as the text it covers. */
const inserted = (before: string, after: string): string[] =>
  decorate(before, after)
    .spans.filter((span) => span.kind === "ins")
    .map((span) => after.slice(span.start, span.end));

/** What it strikes through inside the block that replaced it. */
const struck = (before: string, after: string): string[] =>
  decorate(before, after)
    .deletions.filter((deletion) => !deletion.block)
    .map((deletion) => deletion.text);

/** Whole ranges declared new, as the source they cover. */
const wholly = (before: string, after: string): string[] =>
  decorate(before, after).blocks.map((range) =>
    after.slice(range.start, range.end),
  );

async function renderDiff(before: string, after: string) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[]}
      changedRanges={changedLineRanges(before, after)}
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
  );
  return await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (el.querySelector("[data-loc]") === null) {
      throw new Error("not rendered yet");
    }
    return el;
  });
}

describe("frontmatter field-level diff", () => {
  it("marks only the word that moved inside a value", () => {
    const before = fm("title: Design", "status: draft");
    const after = fm("title: Design", "status: approved");
    expect(inserted(before, after)).toEqual(["approved"]);
    expect(struck(before, after)).toEqual(["draft"]);
  });

  it("puts a strike-through back into a value that was emptied", () => {
    const decorations = decorate(
      fm("title: Design", "status: draft"),
      fm("title: Design", "status:"),
    );
    // The cell has no text node left to strike through, so the overlay puts
    // the old content back into it.
    expect(decorations.tables[0]?.lost).toEqual([
      { row: 1, col: 1, parts: [{ kind: "text", text: "draft" }] },
    ]);
  });

  it("covers a wholly new field's row, not its words", () => {
    const before = fm("title: Design");
    const after = fm("title: Design", "owner: bot-one");
    expect(wholly(before, after)).toEqual(["owner: bot-one"]);
    expect(inserted(before, after)).toEqual([]);
  });

  it("puts a removed field back as a stand-in row", () => {
    const decorations = decorate(
      fm("title: Design", "owner: bot-one"),
      fm("title: Design"),
    );
    expect(decorations.tables[0]?.rows).toEqual([
      {
        at: 1,
        cells: [
          [{ kind: "text", text: "owner" }],
          [{ kind: "text", text: "bot-one" }],
        ],
      },
    ]);
  });

  it("draws nothing at all when the fields only changed order", () => {
    const decorations = decorate(
      fm("title: Design", "status: draft", "owner: bot-one"),
      fm("owner: bot-one", "title: Design", "status: draft"),
    );
    expect(decorations.spans).toEqual([]);
    expect(decorations.deletions).toEqual([]);
    expect(decorations.blocks).toEqual([]);
    expect(decorations.tables).toEqual([]);
  });

  // The boundary with `alignTable`: one field out and one in is two events.
  it("reads one field out and one in as a removal and an addition", () => {
    const before = fm("title: Design", "reviewer: ~");
    const after = fm("title: Design", "approved_by: bot-one");
    // No word diff between the two values, which is what a rename would
    // have produced.
    expect(inserted(before, after)).toEqual([]);
    expect(struck(before, after)).toEqual([]);
    const decorations = decorate(before, after);
    expect(wholly(before, after)).toEqual(["approved_by: bot-one"]);
    expect(decorations.tables[0]?.rows.map((row) => row.cells[0])).toEqual([
      [{ kind: "text", text: "reviewer" }],
    ]);
  });
});

describe("frontmatter as a whole block", () => {
  it("covers the whole block, fences included, when one is added", () => {
    const before = "Body text.\n";
    const after = fm("title: Design");
    expect(wholly(before, after)).toEqual(["---\ntitle: Design\n---"]);
  });

  it("quotes the whole block, fences included, when one is removed", () => {
    const decorations = decorate(fm("title: Design"), "Body text.\n");
    const blockMarkers = decorations.deletions.filter((d) => d.block);
    expect(blockMarkers).toHaveLength(1);
    expect(blockMarkers[0]?.text).toBe("---\ntitle: Design\n---");
  });
});

describe("frontmatter stays out of the prose word bag", () => {
  it("never pairs a frontmatter leaf with a paragraph", () => {
    const before = "---\ntitle: Design\n---\n\nOne paragraph of prose.\n";
    const after = "---\nowner: bot-one\n---\n\nA different paragraph.\n";
    const olds = leavesOf(buildSegmentIndex(before));
    const news = leavesOf(buildSegmentIndex(after));
    // The isolation comes from `SourceBlockType`, not from a line in
    // `classOf`, so it is asserted off the product.
    expect(olds.find((leaf) => leaf.type === "frontmatter")).toBeDefined();
    expect(news.find((leaf) => leaf.type === "frontmatter")).toBeDefined();
    for (const pair of alignGroups(olds, news).pairs) {
      expect(pair.old.type === "frontmatter").toBe(
        pair.new.type === "frontmatter",
      );
    }
  });
});

describe("frontmatter cannot hold a picture (T-239's interaction)", () => {
  const source = fm("title: Design", "cover: ![shot](/api/p/1/a.png)");

  it("builds no image node, no image leaf and no verbatim loss", () => {
    const index = buildSegmentIndex(source);
    const block = index.blocks.find((b) => b.type === "frontmatter");
    expect(block).toBeDefined();
    // `tableBlocks` now also decides which table a picture belongs to (T-239),
    // so this premise failing would make the cell's image vanish in silence.
    for (const image of index.images.values()) {
      expect(
        image.start >= (block?.start ?? 0) && image.end <= (block?.end ?? 0),
      ).toBe(false);
    }
    expect(leavesOf(index).some((leaf) => leaf.type === "image")).toBe(false);
    const cells = index.blocks.filter((b) => b.type === "tableCell");
    const groups = new Set(cells.map((cell) => cell.firstGroup));
    expect(
      index.segments.filter((s) => groups.has(s.group)).map((s) => s.text),
    ).toContain("![shot](/api/p/1/a.png)");
  });
});

describe("the two parse chains stay in step", () => {
  it("points the index block and the rendered table at the same lines", async () => {
    const source = fm("title: Design", "status: draft");
    const container = await renderDiff(source, source);
    const table = container.querySelector("table.markdown-frontmatter");
    const index = buildSegmentIndex(source);
    const block = index.blocks.find((b) => b.type === "frontmatter");
    // When these two disagree the decorations land on nodes that are not
    // there, and `rehypeDecorations` drops them without a word.
    expect(parseSourceLoc(table?.getAttribute("data-loc"))).toEqual({
      start: block?.line,
      end: block?.endLine,
    });
  });
});

describe("a removed row is spliced where it stood", () => {
  it("puts a removed FIRST field at the top of the grid", async () => {
    // The one input that tells `row.at - headRows` from `row.at - 1`: with the
    // literal 1, `childIndexOf` is asked for element -1 and falls through to
    // "append", dropping the removed first field at the bottom instead.
    const container = await renderDiff(
      fm("title: Design", "status: draft", "owner: bot-one"),
      fm("status: draft", "owner: bot-one"),
    );
    const grid = container.querySelector("table.markdown-frontmatter");
    const rows = [...(grid?.querySelectorAll("tbody > tr") ?? [])];
    expect(rows[0]?.className).toContain("spec-del-row");
    expect(rows[0]?.textContent).toContain("title");
    expect(rows.map((row) => row.querySelector("th,td")?.textContent)).toEqual([
      "title",
      "status",
      "owner",
    ]);
  });

  it("still puts an ordinary table's removed first row at the top", async () => {
    // The regression half: a GFM table has `headRows === 1`, so nothing about
    // its behaviour may move.
    const container = await renderDiff(
      "| 甲 | 乙 |\n| --- | --- |\n| 一 | A |\n| 二 | B |\n| 三 | C |\n",
      "| 甲 | 乙 |\n| --- | --- |\n| 二 | B |\n| 三 | C |\n",
    );
    const rows = [...(container.querySelectorAll("table tbody > tr") ?? [])];
    expect(rows[0]?.className).toContain("spec-del-row");
    expect(rows.map((row) => row.querySelector("th,td")?.textContent)).toEqual([
      "一",
      "二",
      "三",
    ]);
  });
});
