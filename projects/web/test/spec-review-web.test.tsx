import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SpecReviewSubmitInput } from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import {
  anchorRangeForNode,
  blockForLine,
  chipTop,
  columnsOfSelection,
} from "../src/components/spec/annotated-markdown.tsx";
import { ReviewSubmitDialog } from "../src/components/spec/review-submit.tsx";
import { SpecCommentAnchorCard } from "../src/components/timeline/spec-comment-card.tsx";
import {
  parseSourceLoc,
  rehypeSourceLines,
} from "../src/lib/rehype-source-lines.ts";
import { useSpecReviewDrafts } from "../src/lib/spec-drafts.ts";
import { buildSegmentIndex } from "../src/lib/spec-source-index.ts";
import { cmGetValue, cmPressKey, cmSetValue } from "./cm.ts";
import { FENCE_SHAPES } from "./fence-shapes.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";
import { reviewViewport } from "./review-viewport.ts";

beforeEach(() => reviewViewport(390));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// Fences render through the lazily-imported pierre CodeView (T-31); pin it
// to a plain pre>code so the DOM is deterministic no matter when the lazy
// chunk would resolve.
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items }: { items: Array<{ file: { contents: string } }> }) => (
    <pre>
      <code>{items.map((item) => item.file.contents).join("\n")}</code>
    </pre>
  ),
  MultiFileDiff: () => null,
}));

describe("rehypeSourceLines", () => {
  it("stamps block elements with their markdown source lines", () => {
    const md = "# Title\n\nFirst paragraph.\n\n- item one\n- item two\n";
    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <MarkdownView rehypePlugins={[rehypeSourceLines]}>{md}</MarkdownView>
      </QueryClientProvider>,
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

  it("keeps the stamp when a fence swaps to CodeBlock (T-52)", () => {
    const md = "intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n";
    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <MarkdownView rehypePlugins={[rehypeSourceLines]}>{md}</MarkdownView>
      </QueryClientProvider>,
    );
    // The fence spans source lines 3-6; its contents begin after the ```.
    const wrapper = view.container.querySelector("div.markdown-fence");
    expect(wrapper?.getAttribute("data-loc")).toBe("3-6");
    expect(wrapper?.getAttribute("data-loc-content-start")).toBe("4");
  });
  it("wraps a fence even when the markdown has no source-line plugin", () => {
    const view = render(
      <QueryClientProvider client={testQueryClient()}>
        <MarkdownView>
          {"before\n\n```ts\nconst a = 1;\n```\n\nafter"}
        </MarkdownView>
      </QueryClientProvider>,
    );
    const wrapper = view.container.querySelector("div.markdown-fence");
    expect(wrapper?.parentElement?.classList.contains("markdown-body")).toBe(
      true,
    );
    expect(wrapper?.querySelector("pre code")?.textContent).toBe(
      "const a = 1;",
    );
  });

  // Three distinct lines: identical ones would let an off-by-one anchor land
  // on a neighbour and still read as containing the right code.
  const CODE_LINES = [
    "const alpha = 1;",
    "const bravo = 2;",
    "const charlie = 3;",
  ];

  it.each(FENCE_SHAPES)(
    "anchors every line of %s to the source line that holds it",
    (_name, of) => {
      const source = of(CODE_LINES);
      const view = render(
        <QueryClientProvider client={testQueryClient()}>
          <MarkdownView rehypePlugins={[rehypeSourceLines]}>
            {source}
          </MarkdownView>
        </QueryClientProvider>,
      );
      const wrapper = view.container.querySelector("[data-loc-content-start]");
      if (wrapper === null) throw new Error("the fence rendered no wrapper");
      // pierre's own shape: one row per content line, in a shadow root.
      const pierreHost = document.createElement("diffs-container");
      wrapper.append(pierreHost);
      const shadow = pierreHost.attachShadow({ mode: "open" });
      shadow.innerHTML = CODE_LINES.map(
        (line, i) => `<div data-line="${i + 1}"><span>${line}</span></div>`,
      ).join("");
      const sourceLines = source.split("\n");
      CODE_LINES.forEach((line, i) => {
        const node = shadow.querySelector(
          `[data-line='${i + 1}'] span`,
        )?.firstChild;
        if (!node) throw new Error(`no row for line ${i + 1}`);
        const range = anchorRangeForNode(node);
        if (range === null) throw new Error(`no anchor for line ${i + 1}`);
        expect(sourceLines[range.start - 1]).toContain(line);
      });
      view.unmount();
    },
  );
});

describe("anchorRangeForNode", () => {
  it("resolves a plain stamped block to its whole range", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p data-loc="3-5">hello</p>`;
    const text = host.querySelector("p")?.firstChild;
    expect(text && anchorRangeForNode(text)).toEqual({ start: 3, end: 5 });
  });

  it("returns null outside any stamped block", () => {
    const host = document.createElement("div");
    host.innerHTML = `<p>unstamped</p>`;
    const text = host.querySelector("p")?.firstChild;
    expect(text && anchorRangeForNode(text)).toBeNull();
  });

  it("narrows to the exact source line on a pierre row, across the shadow root", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-loc", "3-6");
    wrapper.setAttribute("data-loc-content-start", "4");
    const pierreHost = document.createElement("diffs-container");
    wrapper.append(pierreHost);
    const shadow = pierreHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <div data-line="1"><span>const a = 1;</span></div>
      <div data-line="2"><span>const b = 2;</span></div>`;
    const inSecondRow = shadow.querySelector(
      "[data-line='2'] span",
    )?.firstChild;
    // Content line 2 of a fence opening on line 3 → source line 5.
    expect(inSecondRow && anchorRangeForNode(inSecondRow)).toEqual({
      start: 5,
      end: 5,
    });
  });

  it("gives a deletion row the whole block, not a line of the new version", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-loc", "5-13");
    wrapper.setAttribute("data-loc-content-start", "6");
    const pierreHost = document.createElement("diffs-container");
    wrapper.append(pierreHost);
    const shadow = pierreHost.attachShadow({ mode: "open" });
    // A deletion row numbers itself on the OLD side, so `data-line="3"` is
    // the baseline's third content line. Through the formula it would come
    // out as source line 8, which here holds an unrelated statement.
    shadow.innerHTML = `
      <div data-line="3" data-line-type="change-deletion"><span>return max;</span></div>
      <div data-line="5" data-line-type="change-addition"><span>return max + 1;</span></div>
      <div data-line="6" data-line-type="context-expanded"><span>const guard = 0;</span></div>`;
    const at = (type: string) =>
      shadow.querySelector(`[data-line-type='${type}'] span`)?.firstChild ??
      null;
    const deletion = at("change-deletion");
    expect(deletion && anchorRangeForNode(deletion)).toEqual({
      start: 5,
      end: 13,
    });
    // The other three types pierre emits all number the new side, so they
    // keep the formula. `context-expanded` only appears because the fence
    // diff asks for `expandUnchanged`, and it is a new-side number too.
    const addition = at("change-addition");
    expect(addition && anchorRangeForNode(addition)).toEqual({
      start: 10,
      end: 10,
    });
    const expanded = at("context-expanded");
    expect(expanded && anchorRangeForNode(expanded)).toEqual({
      start: 11,
      end: 11,
    });
  });

  it("clamps rows past the stamped end (unclosed fence)", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-loc", "3-4");
    wrapper.setAttribute("data-loc-content-start", "4");
    const pierreHost = document.createElement("diffs-container");
    wrapper.append(pierreHost);
    const shadow = pierreHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div data-line="9"><span>tail</span></div>`;
    const node = shadow.querySelector("span")?.firstChild;
    expect(node && anchorRangeForNode(node)).toEqual({ start: 4, end: 4 });
  });
});

describe("columnsOfSelection", () => {
  it("produces no columns inside a code block", () => {
    const md = "intro\n\n```ts\nconst a = 1;\n```\n";
    const host = document.createElement("div");
    // What MarkdownView renders once the fence swaps to CodeBlock (T-52).
    host.innerHTML =
      '<div data-loc="3-5" data-loc-content-start="4">' +
      "<pre><code>const a = 1;</code></pre></div>";
    const text = host.querySelector("code")?.firstChild;
    if (!text) throw new Error("no code text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    expect(columnsOfSelection(buildSegmentIndex(md), range)).toBeNull();
  });
});

// T-172: chips hung on a table row landed at the top of the document.
describe("chipTop", () => {
  const block = (top: number, offsetTop: number): Element =>
    ({
      offsetTop,
      getBoundingClientRect: () => ({ top }),
    }) as unknown as Element;

  it("measures against the container, not the offsetParent", () => {
    // A <tr> 581px down the container whose offsetParent is its own table,
    // so offsetTop reports the 36px it sits below the table's own top.
    expect(chipTop({ top: 36 }, block(617, 36))).toBe(581);
  });

  it("is unmoved by scrolling, both rects shifting together", () => {
    expect(chipTop({ top: -200 }, block(381, 36))).toBe(581);
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
  it("still reads drafts staged before columns existed (T-142)", () => {
    localStorage.setItem(
      "todou-spec-review:legacy:7",
      JSON.stringify([
        {
          id: "d1",
          anchor: {
            path: "design.md",
            version: 1,
            line_start: 3,
            line_end: 3,
          },
          quote: "…",
          body: "from yesterday",
        },
      ]),
    );
    const hook = renderHook(() => useSpecReviewDrafts("legacy", 7));
    expect(hook.result.current.drafts).toHaveLength(1);
    expect(hook.result.current.drafts[0]?.anchor.col_start).toBeNull();
    expect(hook.result.current.drafts[0]?.body).toBe("from yesterday");
  });

  it("persists drafts per issue across hook instances", () => {
    const first = renderHook(() => useSpecReviewDrafts("p", 23));
    act(() => {
      first.result.current.add({
        anchor: {
          path: "design.md",
          version: 1,
          line_start: 3,
          line_end: 4,
          col_start: null,
          col_end: null,
        },
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

  it("rewrites a draft where it stands, id and order intact (T-159)", () => {
    const hook = renderHook(() => useSpecReviewDrafts("p", 30));
    const anchor = (line: number) => ({
      path: "design.md",
      version: 1,
      line_start: line,
      line_end: line,
      col_start: null,
      col_end: null,
    });
    act(() => {
      hook.result.current.add({ anchor: anchor(3), quote: "…", body: "one" });
    });
    act(() => {
      hook.result.current.add({ anchor: anchor(9), quote: "…", body: "two" });
    });
    const first = hook.result.current.drafts[0];
    if (first === undefined) throw new Error("nothing staged");

    act(() => {
      hook.result.current.update(first.id, {
        // Re-anchored while editing: the same draft now points elsewhere.
        anchor: { ...anchor(5), col_start: 2, col_end: 8 },
        quote: "half a line",
        body: "one, rewritten",
      });
    });

    expect(hook.result.current.drafts).toHaveLength(2);
    expect(hook.result.current.drafts[0]).toEqual({
      id: first.id,
      anchor: { ...anchor(5), col_start: 2, col_end: 8 },
      quote: "half a line",
      body: "one, rewritten",
    });
    expect(hook.result.current.drafts[1]?.body).toBe("two");
    const stored = JSON.parse(
      localStorage.getItem("todou-spec-review:p:30") ?? "[]",
    );
    expect(stored[0].body).toBe("one, rewritten");
  });

  it("ignores an update for a draft that is already gone", () => {
    const hook = renderHook(() => useSpecReviewDrafts("p", 31));
    act(() => {
      hook.result.current.update("d-gone", {
        anchor: {
          path: "design.md",
          version: 1,
          line_start: 3,
          line_end: 3,
          col_start: null,
          col_end: null,
        },
        quote: "…",
        body: "orphan",
      });
    });
    expect(hook.result.current.drafts).toHaveLength(0);
    expect(localStorage.getItem("todou-spec-review:p:31")).toBeNull();
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
      col_start: null,
      col_end: null,
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

const READER = { id: 5, login: "user", display_name: "User", kind: "human" };
const PUSHER = {
  id: 7,
  login: "claude-agent",
  display_name: "Claude Agent",
  kind: "machine",
};

const DRAFT = {
  id: "d1",
  anchor: {
    path: "design.md",
    version: 3,
    line_start: 3,
    line_end: 4,
    col_start: null,
    col_end: null,
  },
  quote: "…",
  body: "Which diff library?",
};

/** GETs never count as reviews, including the spec refetch after success. */
function stubFetch(
  pushedBy = PUSHER,
  respond?: (
    body: SpecReviewSubmitInput,
    attempt: number,
  ) => Response | Promise<Response>,
) {
  const posts: Array<{ url: string; body: SpecReviewSubmitInput }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/api/me")) {
      return Response.json(READER);
    }
    if (method === "GET" && url.includes("/timeline?")) {
      return Response.json({
        items: [],
        prev_cursor: null,
        next_cursor: null,
        total_count: 0,
      });
    }
    if (method === "GET" && url.endsWith("/spec")) {
      return Response.json({
        current_version: 3,
        current_version_cursor: "cv3",
        review_status: "unreviewed",
        unresolved_comments: 0,
        unresolved_carried_comments: 0,
        files: [{ path: "design.md", size: 10 }],
        versions: [
          {
            number: 3,
            author: pushedBy,
            message: null,
            created_at: "2026-09-07T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "POST" && url.endsWith("/issues/23/spec/reviews")) {
      const body: SpecReviewSubmitInput = JSON.parse(String(init?.body));
      posts.push({ url, body });
      return respond
        ? respond(body, posts.length)
        : Response.json(
            {
              event_id: 9,
              version: 3,
              verdict: body.verdict,
              summary_comment_id: body.body ? 88 : null,
              comment_ids: body.comments.map((_, index) => 412 + index),
            },
            { status: 201 },
          );
    }
    throw new Error(`unstubbed request: ${method} ${url}`);
  });
  return posts;
}

const reviewButton = (name: string) => screen.getByRole("button", { name });

describe("ReviewSubmitDialog", () => {
  beforeEach(() => reviewViewport(640));

  it("submits verdict, summary, and every staged draft in one POST", async () => {
    const posts = stubFetch();

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
              col_start: null,
              col_end: null,
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
    await view.findByLabelText("Review summary");

    cmSetValue(view.baseElement, "overall fine");
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(posts).toHaveLength(1);
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

  it("sends columns when the draft carries them (T-142)", async () => {
    const posts = stubFetch();

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
              line_start: 5,
              line_end: 5,
              col_start: 12,
              col_end: 34,
            },
            quote: "half a sentence",
            body: "this clause",
          },
        ]}
        open
        onClose={() => {}}
        onSubmitted={onSubmitted}
      />,
    );

    expect((await view.findByText(/design\.md/)).textContent).toContain(
      "L5:12–34",
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      comments: [
        {
          anchor: {
            path: "design.md",
            version: 3,
            line_start: 5,
            line_end: 5,
            col_start: 12,
            col_end: 34,
          },
        },
      ],
    });
  });
});

describe("ReviewSubmitDialog: responsive controls (T-443)", () => {
  function mount(drafts: Array<typeof DRAFT> = [], pendingVerdict?: "approve") {
    const client = testQueryClient();
    const onClose = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <ReviewSubmitDialog
          slug="p"
          issueNumber={23}
          currentVersion={3}
          drafts={drafts}
          open
          pendingVerdict={pendingVerdict}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    return { client, onClose, view };
  }

  async function settled(client: QueryClient) {
    await waitFor(() => {
      expect(client.getQueryState(["spec", "p", 23])?.status).toBe("success");
      expect(client.getQueryState(["me"])?.status).toBe("success");
    });
  }

  it.each([640, 1280])(
    "at %ipx exposes the verdict buttons and Cancel closes without posting",
    async (width) => {
      reviewViewport(width);
      const posts = stubFetch();
      const { onClose } = mount([DRAFT]);
      for (const name of ["Cancel", "Comment", "Request changes", "Approve"]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(posts).toHaveLength(0);
    },
  );

  it.each([320, 390, 639])(
    "at %ipx exposes the direct verdict row and hides Cancel",
    async (width) => {
      reviewViewport(width);
      stubFetch();
      mount([DRAFT]);
      const buttons = ["Comment", "Request changes", "Approve"].map(
        reviewButton,
      );
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      const row = buttons[0]?.parentElement;
      expect(row).toBeTruthy();
      expect(buttons.every((button) => button.parentElement === row)).toBe(
        true,
      );
    },
  );

  it.each([
    ["empty comment", PUSHER, [], ["Comment"]],
    ["pusher verdicts", READER, [DRAFT], ["Request changes", "Approve"]],
  ] as const)(
    "disables %s in the narrow action row",
    async (_case, author, drafts, names) => {
      const posts = stubFetch(author);
      const { client } = mount([...drafts]);
      await settled(client);
      for (const name of names) {
        const button = reviewButton(name);
        expect(button.hasAttribute("disabled")).toBe(true);
        fireEvent.click(button);
      }
      await act(async () => {});
      expect(posts).toHaveLength(0);
    },
  );

  it.each([390, 640])(
    "at %ipx an empty review disables only Comment",
    async (width) => {
      reviewViewport(width);
      stubFetch();
      const { client } = mount();
      await settled(client);
      const comment = reviewButton("Comment");
      expect(comment.hasAttribute("disabled")).toBe(true);
      expect(comment.title).toBe("Write a summary or stage a comment first");
      expect(reviewButton("Request changes").hasAttribute("disabled")).toBe(
        false,
      );
      expect(reviewButton("Approve").hasAttribute("disabled")).toBe(false);
    },
  );

  it.each([390, 640])(
    "at %ipx the pusher can Comment but cannot submit either verdict",
    async (width) => {
      reviewViewport(width);
      stubFetch(READER);
      const { client } = mount([DRAFT]);
      await settled(client);
      expect(reviewButton("Comment").hasAttribute("disabled")).toBe(false);
      for (const name of ["Request changes", "Approve"]) {
        expect(reviewButton(name).hasAttribute("disabled")).toBe(true);
        expect(reviewButton(name).title).toBe(
          "You pushed this version — its verdict has to come from someone else",
        );
      }
    },
  );

  it("sends one POST when desktop buttons re-enter in the same tick", async () => {
    reviewViewport(640);
    let resolveResponse!: (response: Response) => void;
    const posts = stubFetch(
      PUSHER,
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const { client } = mount([DRAFT]);
    await settled(client);
    const request = screen.getByRole("button", { name: "Request changes" });
    const approve = screen.getByRole("button", { name: "Approve" });
    const reenter = vi.fn(() => {
      expect(request.hasAttribute("disabled")).toBe(false);
      expect(approve.hasAttribute("disabled")).toBe(false);
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    request.addEventListener("click", reenter, { capture: true, once: true });
    act(() => {
      request.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reenter).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body.verdict).toBe("approve");
    const submitting = await screen.findByRole("button", {
      name: "Submitting…",
    });
    expect(submitting.hasAttribute("disabled")).toBe(true);
    for (const name of ["Comment", "Request changes"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
      ).toBe(true);
    }
    await act(async () => {
      resolveResponse(
        Response.json(
          {
            event_id: 9,
            version: 3,
            verdict: "approve",
            summary_comment_id: null,
            comment_ids: [412],
          },
          { status: 201 },
        ),
      );
    });
    await screen.findByRole("button", { name: "Approve" });
    expect(posts).toHaveLength(1);
  });

  it.each([390, 640])(
    "at %ipx respects the session's pending verdict",
    (width) => {
      reviewViewport(width);
      const posts = stubFetch();
      mount([DRAFT], "approve");
      const submitting = screen.getByRole("button", { name: "Submitting…" });
      expect(submitting.hasAttribute("disabled")).toBe(true);
      fireEvent.click(submitting);
      for (const name of ["Comment", "Request changes"]) {
        const button = reviewButton(name);
        expect(button.hasAttribute("disabled")).toBe(true);
        fireEvent.click(button);
      }
      expect(posts).toHaveLength(0);
    },
  );

  it.each([390, 640])(
    "at %ipx keeps the draft and blocks submission when a newer version arrives",
    async (width) => {
      reviewViewport(width);
      const posts = stubFetch();
      const { client, view, onClose } = mount([DRAFT]);
      await settled(client);
      cmSetValue(view.baseElement, "keep this review");

      act(() => {
        client.setQueryData<Record<string, unknown>>(
          ["spec", "p", 23],
          (spec) => ({ ...spec, current_version: 4 }),
        );
      });
      const status = await screen.findByRole("status");
      expect(status.textContent).toBe(
        "Spec v3 is no longer current. Your review draft has been kept.",
      );
      for (const name of ["Comment", "Request changes", "Approve"]) {
        const button = reviewButton(name);
        expect(button.hasAttribute("disabled")).toBe(true);
        fireEvent.click(button);
      }
      await act(async () => {});
      expect(posts).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
      expect(cmGetValue(view.baseElement)).toBe("keep this review");
      expect(screen.getByText("Which diff library?")).toBeTruthy();
    },
  );
});

// T-277: the comment verdict remains available to the version's pusher.
describe("ReviewSubmitDialog: narrow-screen comment verdict", () => {
  function mount(drafts: Array<typeof DRAFT>, onSubmitted = vi.fn()) {
    const client = testQueryClient();
    const onClose = vi.fn();
    const dialog = (staged: Array<typeof DRAFT>) => (
      <QueryClientProvider client={client}>
        <ReviewSubmitDialog
          slug="p"
          issueNumber={23}
          currentVersion={3}
          drafts={staged}
          open
          onClose={onClose}
          onSubmitted={onSubmitted}
        />
      </QueryClientProvider>
    );
    const view = render(dialog(drafts));
    return {
      view,
      client,
      onClose,
      onSubmitted,
      updateDrafts: (staged: Array<typeof DRAFT>) =>
        view.rerender(dialog(staged)),
    };
  }

  it.each([
    ["Comment", "comment", "pointer"],
    ["Request changes", "request_changes", "Enter"],
    ["Approve", "approve", "Space"],
  ] as const)(
    "submits %s (%s) using %s with the latest summary and every current draft",
    async (name, verdict, activation) => {
      const posts = stubFetch();
      const { view, client, onSubmitted, updateDrafts } = mount([DRAFT]);
      cmSetValue(view.baseElement, "superseded summary");
      expect(posts).toHaveLength(0);
      await waitFor(() => {
        expect(client.getQueryState(["spec", "p", 23])?.status).toBe("success");
        expect(client.getQueryState(["me"])?.status).toBe("success");
      });

      const updatedDraft = { ...DRAFT, body: "Use the updated diff library?" };
      const secondDraft = {
        ...DRAFT,
        id: "d2",
        anchor: {
          ...DRAFT.anchor,
          path: "api.md",
          line_start: 8,
          line_end: 9,
        },
        body: "Document the API too",
      };
      updateDrafts([updatedDraft, secondDraft]);
      cmSetValue(view.baseElement, "  latest summary  ");
      const button = reviewButton(name);
      expect(button.tagName).toBe("BUTTON");
      expect(button.hasAttribute("disabled")).toBe(false);
      if (activation === "pointer") {
        fireEvent.click(button);
      } else {
        act(() => button.focus());
        expect(document.activeElement).toBe(button);
        const key = activation === "Space" ? " " : "Enter";
        fireEvent.keyDown(button, { key });
        if (activation === "Space") fireEvent.keyUp(button, { key });
        // happy-dom does not synthesize native button activation from keys.
        // Dispatch the click a browser produces for Enter or Space.
        fireEvent.click(button, { detail: 0 });
        if (activation === "Enter") fireEvent.keyUp(button, { key });
      }

      await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
      expect(posts).toEqual([
        {
          url: expect.stringContaining("/issues/23/spec/reviews"),
          body: {
            version: 3,
            verdict,
            body: "latest summary",
            comments: [
              {
                anchor: {
                  path: "design.md",
                  version: 3,
                  line_start: 3,
                  line_end: 4,
                },
                body: "Use the updated diff library?",
              },
              {
                anchor: {
                  path: "api.md",
                  version: 3,
                  line_start: 8,
                  line_end: 9,
                },
                body: "Document the API too",
              },
            ],
          },
        },
      ]);
    },
  );

  it("disables every action when the pusher has nothing to comment", async () => {
    const posts = stubFetch(READER);
    const { view, onSubmitted } = mount([]);
    cmSetValue(view.baseElement, " \n ");
    await waitFor(() =>
      expect(reviewButton("Approve").hasAttribute("disabled")).toBe(true),
    );
    for (const name of ["Comment", "Request changes", "Approve"]) {
      const button = reviewButton(name);
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
    }
    await act(async () => {});
    expect(posts).toHaveLength(0);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(cmGetValue(view.baseElement)).toBe(" \n ");
  });

  it("sends one POST for two enabled button activations before rerender", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const posts = stubFetch(PUSHER, () => response);
    const { view, client, onSubmitted } = mount([DRAFT]);
    cmSetValue(view.baseElement, "same-tick summary");
    await waitFor(() => {
      expect(client.getQueryState(["spec", "p", 23])?.status).toBe("success");
      expect(client.getQueryState(["me"])?.status).toBe("success");
    });
    const requestChanges = reviewButton("Request changes");
    const approve = reviewButton("Approve");
    expect(requestChanges.hasAttribute("disabled")).toBe(false);
    expect(approve.hasAttribute("disabled")).toBe(false);

    // Re-enter before the first click reaches its React handler. Approve
    // submits first; the stale Request changes callback must not post again.
    const activateAgain = vi.fn(() => {
      expect(requestChanges.isConnected).toBe(true);
      expect(approve.isConnected).toBe(true);
      expect(requestChanges.hasAttribute("disabled")).toBe(false);
      expect(approve.hasAttribute("disabled")).toBe(false);
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    requestChanges.addEventListener("click", activateAgain, {
      capture: true,
      once: true,
    });
    act(() => {
      requestChanges.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(activateAgain).toHaveBeenCalledTimes(1);
    await act(async () => {});
    const submitting = await screen.findByRole("button", {
      name: "Submitting…",
    });
    expect(submitting.hasAttribute("disabled")).toBe(true);
    for (const name of ["Comment", "Request changes"]) {
      expect(reviewButton(name).hasAttribute("disabled")).toBe(true);
    }
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      version: 3,
      verdict: "approve",
      body: "same-tick summary",
      comments: [
        {
          anchor: { path: "design.md", version: 3, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
      ],
    });

    await act(async () => {
      resolveResponse(
        Response.json(
          {
            event_id: 9,
            version: 3,
            verdict: "approve",
            summary_comment_id: 88,
            comment_ids: [412],
          },
          { status: 201 },
        ),
      );
    });
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(1);
  });

  it("disables Submitting while a response is delayed and ignores duplicate activation", async () => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const posts = stubFetch(PUSHER, () => response);
    const { view, onSubmitted } = mount([DRAFT]);
    cmSetValue(view.baseElement, "held summary");
    fireEvent.click(reviewButton("Request changes"));
    await waitFor(() => expect(posts).toHaveLength(1));
    const submitting = await screen.findByRole("button", {
      name: "Submitting…",
    });
    expect(submitting.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submitting);
    for (const name of ["Comment", "Approve"]) {
      const button = reviewButton(name);
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(button);
    }
    await act(async () => {});
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      version: 3,
      verdict: "request_changes",
      body: "held summary",
      comments: [
        {
          anchor: { path: "design.md", version: 3, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
      ],
    });
    expect(onSubmitted).not.toHaveBeenCalled();
    await act(async () => {
      resolveResponse(
        Response.json(
          {
            event_id: 9,
            version: 3,
            verdict: "request_changes",
            summary_comment_id: 88,
            comment_ids: [412],
          },
          { status: 201 },
        ),
      );
    });
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(1);
    expect(reviewButton("Request changes").hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("retains the summary and drafts after failure and posts them on retry", async () => {
    const posts = stubFetch(PUSHER, (body, attempt) =>
      attempt === 1
        ? Response.json(
            { error: { code: "internal_error", message: "Try again" } },
            { status: 500 },
          )
        : Response.json(
            {
              event_id: 9,
              version: 3,
              verdict: body.verdict,
              summary_comment_id: 88,
              comment_ids: [412],
            },
            { status: 201 },
          ),
    );
    const { view, onSubmitted, onClose } = mount([DRAFT]);
    cmSetValue(view.baseElement, "retain this summary");
    fireEvent.click(reviewButton("Comment"));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", {
            name: "Comment",
          })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(cmGetValue(view.baseElement)).toBe("retain this summary");
    expect(screen.getByText("Which diff library?")).toBeTruthy();

    fireEvent.click(reviewButton("Comment"));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(2);
    const expected = {
      version: 3,
      verdict: "comment",
      body: "retain this summary",
      comments: [
        {
          anchor: { path: "design.md", version: 3, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
      ],
    };
    expect(posts.map((post) => post.body)).toEqual([expected, expected]);
  });

  it("posts verdict comment with the summary and every staged draft", async () => {
    const posts = stubFetch(PUSHER);
    const { view, onSubmitted } = mount([DRAFT]);

    cmSetValue(view.baseElement, "three spots I am unsure of");
    const comment = reviewButton("Comment");
    await waitFor(() => expect(comment.hasAttribute("disabled")).toBe(false));
    fireEvent.click(comment);

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      version: 3,
      verdict: "comment",
      body: "three spots I am unsure of",
      comments: [
        {
          anchor: { path: "design.md", version: 3, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
      ],
    });
  });

  it("disables the two verdicts for the account that pushed the version", async () => {
    const posts = stubFetch(READER);
    const { onSubmitted } = mount([DRAFT]);

    const approve = reviewButton("Approve");
    await waitFor(() => expect(approve.hasAttribute("disabled")).toBe(true));
    const requestChanges = reviewButton("Request changes");
    expect(requestChanges.hasAttribute("disabled")).toBe(true);
    expect(approve.title).toContain("verdict has to come from someone else");
    // The one form that account may submit stays open to it.
    expect(reviewButton("Comment").hasAttribute("disabled")).toBe(false);
    for (const button of [approve, requestChanges]) {
      fireEvent.click(button);
    }
    await act(async () => {});
    expect(posts).toHaveLength(0);
    expect(onSubmitted).not.toHaveBeenCalled();
    fireEvent.click(reviewButton("Comment"));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      version: 3,
      verdict: "comment",
      comments: [
        {
          anchor: { path: "design.md", version: 3, line_start: 3, line_end: 4 },
          body: "Which diff library?",
        },
      ],
    });
  });

  it("leaves the two verdicts enabled for anyone else", async () => {
    stubFetch(PUSHER);
    const { client } = mount([DRAFT]);

    await waitFor(() => {
      expect(client.getQueryState(["spec", "p", 23])?.status).toBe("success");
      expect(client.getQueryState(["me"])?.status).toBe("success");
    });
    const approve = reviewButton("Approve");
    // The disable is driven by an async read, so a passing assertion has to
    // outlast it rather than beat it.
    await waitFor(() =>
      expect(reviewButton("Request changes").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(approve.title).toBeFalsy();
  });

  it("disables Comment while it would say nothing", async () => {
    const posts = stubFetch(PUSHER);
    const { view } = mount([]);

    const comment = reviewButton("Comment");
    expect(comment.hasAttribute("disabled")).toBe(true);
    expect(comment.title).toContain("Write a summary or stage a comment");
    fireEvent.click(comment);
    await act(async () => {});
    expect(posts).toHaveLength(0);
    cmSetValue(view.baseElement, "something");
    await waitFor(() =>
      expect(reviewButton("Comment").hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(reviewButton("Comment"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({
      version: 3,
      verdict: "comment",
      body: "something",
      comments: [],
    });
  });

  it("does not choose a verdict on Ctrl-Enter in the summary", async () => {
    const posts = stubFetch(PUSHER);
    const { view } = mount([DRAFT]);

    await view.findByRole("button", { name: "Comment" });
    cmSetValue(view.baseElement, "a summary with no verdict picked");

    cmPressKey(view.baseElement, "Enter", { ctrlKey: true });

    await act(async () => {});
    expect(posts).toEqual([]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    for (const name of ["Comment", "Request changes", "Approve"]) {
      expect(reviewButton(name)).toBeTruthy();
    }
    // The blank line did not land on Ctrl-Enter either.
    expect(cmGetValue(view.baseElement)).toBe(
      "a summary with no verdict picked",
    );
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
