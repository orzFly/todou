import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { AnnotatedMarkdown } from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders } from "./render.tsx";

// Same pin as the other rendered-view suites: fences go through pierre.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

/** What the reader's page holds, which is the only judge of "it changed". */
async function html(source: string): Promise<string> {
  const { container } = renderWithProviders(
    <MarkdownView>{source}</MarkdownView>,
  );
  const body = await waitFor(() => {
    const el = container.querySelector(".markdown-body");
    if (el === null) throw new Error("not rendered yet");
    return el;
  });
  return body.innerHTML;
}

/** Both marks the change navigation steps over (`CHANGED_SELECTOR`). */
const CHANGED = ".spec-changed, .spec-ins-block";

async function renderSpec(before: string, after: string) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={after}
      baselineBody={before}
      annotations={[]}
      changedRanges={changedLineRanges(before, after)}
      foldUnchanged={false}
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

function itemNamed(container: HTMLElement, text: string): HTMLElement {
  const item = [...container.querySelectorAll("li")].find(
    (el) => el.textContent?.trim() === text,
  );
  if (item === undefined) throw new Error(`no list item reading ${text}`);
  return item;
}

const marked = (el: HTMLElement) =>
  el.matches(CHANGED) || el.querySelector(CHANGED) !== null;

const FOUR = "# 标题\n\n1. 第一项\n2. 第二项\n3. 第三项\n4. 第四项\n";
const FIVE =
  "# 标题\n\n1. 第一项\n2. 新插入的一项\n3. 第二项\n4. 第三项\n5. 第四项\n";

/**
 * Each pair says what it does to the page, and the suite checks that against
 * the page itself. Pinning the verdict is what makes the pair evidence: a
 * renderer that started emitting `<ol start>` for every item would otherwise
 * quietly turn a "same" row into a vacuous one.
 */
const RULES: Array<{
  what: string;
  before: string;
  after: string;
  rendersSame: boolean;
}> = [
  {
    what: "renumbers every item but the first",
    before: "1. alpha\n2. beta\n3. gamma\n",
    after: "1. alpha\n9. beta\n10. gamma\n",
    rendersSame: true,
  },
  {
    what: "rewrites the delimiter of a whole ordered list",
    before: "1. alpha\n2. beta\n",
    after: "1) alpha\n2) beta\n",
    rendersSame: true,
  },
  {
    what: "renumbers the first item",
    before: "1. alpha\n2. beta\n",
    after: "5. alpha\n6. beta\n",
    rendersSame: false,
  },
  {
    what: "rewrites the delimiter of one item",
    before: "1. alpha\n2. beta\n3. gamma\n",
    after: "1. alpha\n2) beta\n3) gamma\n",
    rendersSame: false,
  },
  {
    what: "turns an ordered list into an unordered one",
    before: "1. alpha\n2. beta\n",
    after: "- alpha\n- beta\n",
    rendersSame: false,
  },
  {
    what: "rewrites the bullet of a whole unordered list",
    before: "- alpha\n- beta\n",
    after: "* alpha\n* beta\n",
    rendersSame: true,
  },
  {
    what: "rewrites the bullet of one item",
    before: "- alpha\n- beta\n- gamma\n",
    after: "- alpha\n* beta\n* gamma\n",
    rendersSame: false,
  },
  {
    what: "widens the gap between a marker and its content",
    before: "- alpha\n- beta\n",
    after: "-  alpha\n-   beta\n",
    rendersSame: true,
  },
  {
    what: "re-pads a table's columns",
    before: "| a | b |\n|---|---|\n| 1 | 2 |\n",
    after: "| a     | b |\n| ----- | --- |\n| 1     | 2 |\n",
    rendersSame: true,
  },
  {
    what: "drops a table's outer pipes",
    before: "| a | b |\n|---|---|\n| 1 | 2 |\n",
    after: "a | b\n--- | ---\n1 | 2\n",
    rendersSame: true,
  },
  {
    what: "adds alignment colons to a table",
    before: "| a | b |\n|---|---|\n| 1 | 2 |\n",
    after: "| a | b |\n|:--|--:|\n| 1 | 2 |\n",
    rendersSame: false,
  },
  {
    what: "leaves one space at the end of a line",
    before: "第一句。\n第二句。\n",
    after: "第一句。 \n第二句。\n",
    rendersSame: true,
  },
  {
    what: "leaves two spaces at the end of a line",
    before: "第一句。\n第二句。\n",
    after: "第一句。  \n第二句。\n",
    rendersSame: false,
  },
  {
    what: "re-wraps a paragraph's soft line breaks",
    before: "中文很长的一句话需要换行了。\n",
    after: "中文很长的\n一句话需要换行了。\n",
    rendersSame: false,
  },
];

describe("a change is what the page shows", () => {
  it.each(RULES)("$what", async ({ before, after, rendersSame }) => {
    expect((await html(before)) === (await html(after))).toBe(rendersSame);
    expect(changedLineRanges(before, after)).toHaveLength(rendersSame ? 0 : 1);
  });
});

describe("re-review marks", () => {
  it("marks the inserted item and leaves the ones it renumbered", async () => {
    const container = await renderSpec(FOUR, FIVE);
    expect(marked(itemNamed(container, "新插入的一项"))).toBe(true);
    expect(marked(itemNamed(container, "第三项"))).toBe(false);
    expect(marked(itemNamed(container, "第四项"))).toBe(false);
  });

  it("marks a first item whose number the reader can see", async () => {
    const container = await renderSpec(
      "1. alpha\n2. beta\n",
      "5. alpha\n6. beta\n",
    );
    expect(marked(itemNamed(container, "alpha"))).toBe(true);
  });

  it("marks the item a delimiter change split the list at", async () => {
    const container = await renderSpec(
      "1. alpha\n2. beta\n3. gamma\n",
      "1. alpha\n2) beta\n3) gamma\n",
    );
    expect(marked(itemNamed(container, "beta"))).toBe(true);
  });

  it("marks a list that turned unordered", async () => {
    const container = await renderSpec(
      "1. alpha\n2. beta\n",
      "- alpha\n- beta\n",
    );
    expect(marked(itemNamed(container, "alpha"))).toBe(true);
  });

  // A rule driven by line shape rather than by the parse reads these two as
  // list items and renumbers them out of the comparison.
  it("leaves numbered lines inside a fence alone", async () => {
    const before = "前言。\n\n```\n3. foo\n4. bar\n```\n";
    const after = "改写后的前言。\n\n```\n3. foo\n4. bar\n```\n";
    expect(changedLineRanges(before, after)).toEqual([{ start: 1, end: 1 }]);
    const fenced = "前言。\n\n```\n3. foo\n9. bar\n```\n";
    expect(changedLineRanges(before, fenced)).toEqual([{ start: 5, end: 5 }]);
  });

  it("reads a table's move into a blockquote as a change", async () => {
    const plain = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const padded = "| a   | b   |\n| --- | --- |\n| 1   | 2   |\n";
    const quoted = "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n";
    expect(changedLineRanges(plain, padded)).toEqual([]);
    expect((await html(plain)) === (await html(quoted))).toBe(false);
    expect(changedLineRanges(plain, quoted).length).toBeGreaterThan(0);
  });
});
