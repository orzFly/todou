import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  ReferenceConfig,
  SpecCommentItem,
} from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import {
  AnnotatedMarkdown,
  type DisplayedAnnotation,
} from "../src/components/spec/annotated-markdown.tsx";
import { changedLineRanges } from "../src/lib/spec-changes.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// Same pin as spec-inline-diff: fences go through pierre's lazy CodeView.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

const SINCE = "2026-01-01T00:00:00.000Z";

/** The project spells its issues "T-N", as the card's own project does. */
const PREFIXED: ReferenceConfig = {
  format: { prefix: "T", history: [{ prefix: "T", effective_from: SINCE }] },
  autolinks: [],
};

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "In Progress",
    category: "open",
    color: "#bf8700",
    position: 2,
    is_default: false,
  },
  author: {
    id: 1,
    login: "user",
    display_name: "User",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: SINCE,
  updated_at: SINCE,
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
});

function seeded(...numbers: number[]): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery("p").queryKey, PREFIXED);
  for (const number of numbers) {
    client.setQueryData(
      issueRefQuery("p", number).queryKey,
      refItem(number, `目标议题 ${number}`),
    );
  }
  return client;
}

function comment(anchor: Partial<SpecCommentItem["anchor"]>): SpecCommentItem {
  return {
    comment_id: 1,
    author: {
      id: 1,
      login: "alice",
      display_name: "alice",
      kind: "human",
      avatar_url: null,
      owner: null,
    },
    created_at: SINCE,
    body: "note",
    anchor: {
      path: "design.md",
      version: 1,
      line_start: null,
      line_end: null,
      col_start: null,
      col_end: null,
      quote: "",
      ...anchor,
    },
    resolved: null,
    outdated: false,
    current_line_start: null,
    current_line_end: null,
  };
}

/** One column-anchored annotation, of either kind. */
function anchored(
  kind: "comment" | "draft",
  start: number,
  colStart: number,
  end: number,
  colEnd: number,
): DisplayedAnnotation {
  const at = { start, end, colStart, colEnd, key: "c1" };
  return kind === "comment"
    ? {
        ...at,
        kind,
        item: comment({ line_start: start, line_end: end }),
      }
    : {
        ...at,
        kind,
        draft: {
          id: "d1",
          anchor: {
            path: "design.md",
            version: 1,
            line_start: start,
            line_end: end,
            col_start: colStart,
            col_end: colEnd,
          },
          quote: "",
          body: "draft note",
        },
      };
}

async function renderSpec(opts: {
  body: string;
  baselineBody?: string;
  annotations?: DisplayedAnnotation[];
  client?: QueryClient;
  ready?: string;
}) {
  const view = renderWithProviders(
    <AnnotatedMarkdown
      slug="p"
      issueNumber={1}
      body={opts.body}
      baselineBody={opts.baselineBody}
      annotations={opts.annotations ?? []}
      changedRanges={
        opts.baselineBody === undefined
          ? []
          : changedLineRanges(opts.baselineBody, opts.body)
      }
      onStage={() => {}}
      onEditDraft={() => {}}
      onRemoveDraft={() => {}}
      onResolve={() => {}}
    />,
    opts.client,
  );
  const container = await waitFor(() => {
    const el = view.getByTestId("annotated-markdown");
    if (el.querySelector(opts.ready ?? "[data-loc]") === null) {
      throw new Error("not rendered yet");
    }
    return el;
  });
  return { view, container };
}

const texts = (container: HTMLElement, selector: string) =>
  [...container.querySelectorAll(selector)].map((el) => el.textContent);

// T-164, the card's own repro: a selection spanning three blocks left the
// middle one — the only one holding a ref — with no highlight at all,
// while the quote preview underneath proved the anchor had it all along.
describe("annotation highlights across a ref chip (T-164)", () => {
  const BODY = [
    "## 结论，就地展开",
    "",
    "- 第一条 bullet 提到 T-161 的做法。",
    "- 第二条 bullet 没有引用。",
    "",
  ].join("\n");

  it("marks the whole bullet, chip included", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 4, 4, 8)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    const mark = chip?.closest("mark.spec-mark-comment");
    expect(mark).not.toBeNull();
    // The key is what the popover's "scroll to this" button aims at.
    expect(mark?.getAttribute("data-mark-key")).toBe("c1");
    const marked = texts(container, "li mark.spec-mark-comment").join("");
    expect(marked).toContain("第一条 bullet 提到");
    expect(marked).toContain("的做法。");
    // …and the neighbours the selection also covered.
    expect(texts(container, "h2 mark.spec-mark-comment")).toEqual([
      "结论，就地展开",
    ]);
  });

  it("keeps the chip a chip — no mark spliced into its children", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 3, 3, 3, 20)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.textContent).toContain("目标议题 161");
    expect(chip?.querySelector("mark")).toBeNull();
  });

  it("wraps the chip in an insertion when the ref is new (compare mode)", async () => {
    const { container } = await renderSpec({
      body: "- 参考 T-161 的既有做法。\n",
      baselineBody: "- 参考既有做法。\n",
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.closest("ins.spec-ins")).not.toBeNull();
    expect(chip?.textContent).toContain("目标议题 161");
  });

  it("gives an unbreakable bullet the whole-node highlight", async () => {
    // The continuation indent stretches the source span past the rendered
    // value, so the pieces cannot be measured — all of it, or none.
    const { container } = await renderSpec({
      body: "- 第一条 bullet 提到 T-161，\n  并且换到第二行继续写。\n- 第二条。\n",
      annotations: [anchored("comment", 1, 3, 2, 5)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.closest("mark.spec-mark-comment")).not.toBeNull();
    const marked = texts(container, "li mark.spec-mark-comment").join("");
    expect(marked).toContain("第一条 bullet 提到");
    expect(marked).toContain("并且换到第二行继续写。");
    // The bullet below was never in the anchor's range.
    expect(container.querySelectorAll("li")[1]?.textContent).toBe("第二条。");
  });
});

// A pasted permalink renders as a chip only while its <a> holds one plain
// text child. Painting a mark in there quietly downgraded it to a bare URL.
describe("a highlighted permalink stays a chip (T-164)", () => {
  const HREF = "http://localhost:3000/projects/p/issues/161";
  const LINE = `见 <${HREF}> 的结论。`;

  it("upgrades under a mark that covers the whole line", async () => {
    const { container } = await renderSpec({
      body: `${LINE}\n`,
      annotations: [anchored("comment", 1, 1, 1, LINE.length)],
      client: seeded(161),
      ready: "a[data-issue-link]",
    });
    const chip = container.querySelector("a[data-issue-link='161']");
    expect(chip?.textContent).toContain("目标议题 161");
    expect(chip?.closest("mark.spec-mark-comment")).not.toBeNull();
    expect(container.textContent).not.toContain(HREF);
  });
});

// The reviewer's second report: an anchor whose columns run across a fence.
// pierre owns the inside of a code block, so the block itself has to say it.
describe("annotations reaching into a code block (T-164)", () => {
  const BODY = [
    "abc",
    "",
    "```bash",
    "$ hello",
    "$ bad",
    "```",
    "",
    "尾段结论。",
    "",
  ].join("\n");

  it("washes the block and keeps the prose marks on either side", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 1, 8, 2)],
    });
    const block = container.querySelector("div[data-loc]");
    expect(block?.classList.contains("spec-mark-comment-block")).toBe(true);
    expect(texts(container, "p mark.spec-mark-comment")).toEqual([
      "abc",
      "尾段",
    ]);
    // Nothing was injected into the code itself — pierre reads it back out
    // by concatenating text children, and a <mark> would delete a line.
    expect(container.querySelector("pre")?.textContent).toBe("$ hello\n$ bad");
    expect(container.querySelector("pre mark")).toBeNull();
  });

  it("wears the draft colour for a staged draft", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("draft", 1, 1, 8, 2)],
    });
    const block = container.querySelector("div[data-loc]");
    expect(block?.classList.contains("spec-mark-draft-block")).toBe(true);
    expect(block?.classList.contains("spec-mark-comment-block")).toBe(false);
  });

  it("leaves a fence alone when the anchor stops short of it", async () => {
    const { container } = await renderSpec({
      body: BODY,
      annotations: [anchored("comment", 1, 1, 1, 3)],
    });
    const block = container.querySelector("div[data-loc]");
    expect(block?.className).not.toContain("spec-mark");
  });
});
