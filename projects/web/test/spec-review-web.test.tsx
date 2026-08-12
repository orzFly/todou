import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { blockForLine } from "../src/components/spec/annotated-markdown.tsx";
import { ReviewSubmitDialog } from "../src/components/spec/review-submit.tsx";
import { SpecCommentAnchorCard } from "../src/components/timeline/spec-comment-card.tsx";
import {
  parseSourceLoc,
  rehypeSourceLines,
} from "../src/lib/rehype-source-lines.ts";
import { useSpecReviewDrafts } from "../src/lib/spec-drafts.ts";
import { renderWithProviders } from "./render.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("rehypeSourceLines", () => {
  it("stamps block elements with their markdown source lines", () => {
    const md = "# Title\n\nFirst paragraph.\n\n- item one\n- item two\n";
    const view = render(
      <MarkdownView rehypePlugins={[rehypeSourceLines]}>{md}</MarkdownView>,
    );
    const h1 = view.container.querySelector("h1");
    expect(h1?.getAttribute("data-loc")).toBe("1-1");
    const p = view.container.querySelector("p");
    expect(p?.getAttribute("data-loc")).toBe("3-3");
    const items = view.container.querySelectorAll("li");
    expect(items[0]?.getAttribute("data-loc")).toBe("5-5");
    expect(items[1]?.getAttribute("data-loc")).toBe("6-6");
  });

  it("parses and rejects loc attributes", () => {
    expect(parseSourceLoc("3-7")).toEqual({ start: 3, end: 7 });
    expect(parseSourceLoc("x")).toBeNull();
    expect(parseSourceLoc(null)).toBeNull();
  });
});

describe("blockForLine", () => {
  const blocks = [
    { start: 1, end: 1 },
    { start: 3, end: 5 },
    { start: 8, end: 9 },
  ];
  it("finds the containing block", () => {
    expect(blockForLine(blocks, 4)).toBe(1);
    expect(blockForLine(blocks, 8)).toBe(2);
  });
  it("falls back to the closest earlier block for gap lines", () => {
    expect(blockForLine(blocks, 6)).toBe(1);
  });
  it("returns -1 before the first block", () => {
    expect(blockForLine(blocks, 0)).toBe(-1);
  });
});

describe("useSpecReviewDrafts", () => {
  it("persists drafts per issue across hook instances", () => {
    const first = renderHook(() => useSpecReviewDrafts("p", 23));
    act(() => {
      first.result.current.add({
        anchor: { path: "design.md", version: 1, line_start: 3, line_end: 4 },
        quote: "…",
        body: "draft one",
      });
    });
    expect(first.result.current.drafts).toHaveLength(1);

    const second = renderHook(() => useSpecReviewDrafts("p", 23));
    expect(second.result.current.drafts).toHaveLength(1);
    expect(second.result.current.drafts[0]?.body).toBe("draft one");

    const other = renderHook(() => useSpecReviewDrafts("p", 24));
    expect(other.result.current.drafts).toHaveLength(0);

    act(() => {
      const id = second.result.current.drafts[0]?.id;
      if (id) second.result.current.remove(id);
    });
    expect(second.result.current.drafts).toHaveLength(0);
  });
});

describe("SpecCommentAnchorCard", () => {
  const component = {
    type: "spec_comment" as const,
    anchor: {
      path: "design.md",
      version: 2,
      line_start: 3,
      line_end: 4,
      quote: "Anchors point at…\nResolve is one-way.",
    },
  };

  it("shows the anchor, quote, and resolve affordance", async () => {
    const view = renderWithProviders(
      <SpecCommentAnchorCard
        slug="p"
        issueNumber={23}
        commentId={412}
        component={component}
        resolvedAt={null}
        canResolve
      />,
    );
    expect(await view.findByText("design.md")).toBeTruthy();
    expect(view.getByText(/L3–4/)).toBeTruthy();
    expect(view.getByText(/Anchors point at…/)).toBeTruthy();
    expect(view.getByText("Resolve")).toBeTruthy();
  });

  it("shows the resolved badge instead once resolved", async () => {
    const view = renderWithProviders(
      <SpecCommentAnchorCard
        slug="p"
        issueNumber={23}
        commentId={412}
        component={component}
        resolvedAt="2026-08-12T07:00:00Z"
        canResolve
      />,
    );
    expect(await view.findByText("resolved")).toBeTruthy();
    expect(view.queryByText("Resolve")).toBeNull();
  });
});

describe("ReviewSubmitDialog", () => {
  it("submits verdict, summary, and every staged draft in one POST", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json(
        {
          event_id: 9,
          version: 3,
          verdict: "request_changes",
          summary_comment_id: 88,
          comment_ids: [412],
        },
        { status: 201 },
      );
    });

    const onSubmitted = vi.fn();
    const view = renderWithProviders(
      <ReviewSubmitDialog
        slug="p"
        issueNumber={23}
        currentVersion={3}
        drafts={[
          {
            id: "d1",
            anchor: {
              path: "design.md",
              version: 3,
              line_start: 3,
              line_end: 4,
            },
            quote: "…",
            body: "Which diff library?",
          },
        ]}
        open
        onClose={() => {}}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.change(await view.findByPlaceholderText(/Summary/), {
      target: { value: "overall fine" },
    });
    fireEvent.click(view.getByText("Request changes"));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(posts[0]?.url).toContain("/issues/23/spec/reviews");
    expect(posts[0]?.body).toEqual({
      version: 3,
      verdict: "request_changes",
      body: "overall fine",
      comments: [
        {
          anchor: { path: "design.md", version: 3, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
      ],
    });
  });
});

describe("changedLineRanges", () => {
  it("marks insertions and rewrites in new-version coordinates", async () => {
    const { changedLineRanges } = await import("../src/lib/spec-changes.ts");
    const oldBody = "a\nb\nc\nd\n";
    expect(changedLineRanges(oldBody, oldBody)).toEqual([]);
    // Rewrite line 2 → remove+add pair lands on new line 2.
    expect(changedLineRanges(oldBody, "a\nB\nc\nd\n")).toEqual([
      { start: 2, end: 2 },
    ]);
    // Two inserted header lines.
    expect(changedLineRanges(oldBody, "h1\nh2\na\nb\nc\nd\n")).toEqual([
      { start: 1, end: 2 },
    ]);
    // Everything new.
    expect(changedLineRanges("", "x\ny\n")).toEqual([{ start: 1, end: 2 }]);
  });
});
