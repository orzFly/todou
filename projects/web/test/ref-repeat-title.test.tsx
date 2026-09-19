import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  TimelineComment,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  commentRefQuery,
  issueRefQuery,
  type ResolvedCommentRef,
  type ResolvedIssueRef,
} from "../src/api/issue-refs.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const refItem = (number: number, title: string): IssueListItem => ({
  id: number,
  number,
  title,
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author,
  assignees: [],
  labels: [],
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
});

const commentOf = (id: number): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: "hi",
  created_at: "2026-08-12T00:00:00Z",
  component: null,
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});

const config: ReferenceConfig = {
  format: { prefix: "T", history: [] },
  autolinks: [],
};

const PREFS: MePrefs = {
  show_weak_unread: true,
  ref_placement_list: "before",
  ref_placement_board: "own_line",
  ref_placement_detail: "before",
  ref_placement_reference: "before",
  boxed_ref_links: true,
  truncate_ref_title: true,
  show_repeated_ref_title: false,
};

function seeded(overrides: Partial<MePrefs> = {}): QueryClient {
  const client = testQueryClient();
  client.setQueryData(referenceConfigQuery("todou").queryKey, config);
  client.setQueryData(issueRefQuery("todou", 7).queryKey, refItem(7, "Target"));
  client.setQueryData(issueRefQuery("todou", 8).queryKey, refItem(8, "Other"));
  client.setQueryData<ResolvedCommentRef | null>(
    commentRefQuery("todou", 7, 42).queryKey,
    () => ({
      ...commentOf(42),
      at: { slug: "todou", number: 7, commentId: 42 },
    }),
  );
  client.setQueryData(prefsQuery.queryKey, { ...PREFS, ...overrides });
  return client;
}

/** The rendered title of every link pointing at card 7, in document order. */
const titlesOfSeven = (root: ParentNode): string[] =>
  [...root.querySelectorAll("a[data-issue-link='7']")].map((a) => {
    const label = a.hasAttribute("data-comment-link")
      ? a.querySelector("[data-comment-title]")
      : [...a.children].find((c) => c.classList.contains("truncate"));
    return label?.textContent ?? "";
  });

const THRICE =
  "first [T-7](/projects/todou/issues/7), " +
  "second [T-7](/projects/todou/issues/7), " +
  "third [T-7](/projects/todou/issues/7)";

describe("repeated references in one document (T-371)", () => {
  it("keeps the title only on the first mention", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">{THRICE}</MarkdownView>,
      seeded(),
    );
    await waitFor(() => {
      expect(
        view.container.querySelectorAll("a[data-issue-link='7']"),
      ).toHaveLength(3);
    });
    expect(titlesOfSeven(view.container)).toEqual(["Target", "", ""]);
    // Dropping the title must not drop the ref with it.
    expect(view.container.textContent).toContain("T-7");
  });

  it("counts a different card separately", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"[T-7](/projects/todou/issues/7) then [T-8](/projects/todou/issues/8)"}
      </MarkdownView>,
      seeded(),
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("a[data-issue-link='8']"),
      ).not.toBeNull();
    });
    expect(view.container.textContent).toContain("Target");
    expect(view.container.textContent).toContain("Other");
  });

  it("drops a repeated comment's title but keeps its complete ref and author", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"[T-7](/projects/todou/issues/7) and again " +
          "[T-7#comment-42](/projects/todou/issues/7#comment-42)"}
      </MarkdownView>,
      seeded(),
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("a[data-comment-link='42']"),
      ).not.toBeNull();
    });
    expect(titlesOfSeven(view.container)).toEqual(["Target", ""]);
    const second = view.container.querySelector("a[data-comment-link='42']");
    expect(second?.textContent).toBe("T-7#comment-42 by Alice");
    const scope = second?.querySelector("[data-comment-ref]");
    expect(
      [...(second?.querySelectorAll("[data-ref-part]") ?? [])]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("T-7#comment-42");
    expect(
      scope?.contains(second?.querySelector("[data-comment-author]") ?? null),
    ).toBe(false);
    expect(second?.querySelector("[data-comment-author]")?.textContent).toBe(
      " by Alice",
    );
    expect(second?.textContent).not.toContain("Target");
  });

  it("starts counting again in the next document", async () => {
    const client = seeded();
    const one = renderWithProviders(
      <MarkdownView slug="todou">
        {"[T-7](/projects/todou/issues/7)"}
      </MarkdownView>,
      client,
    );
    await waitFor(() => {
      expect(titlesOfSeven(one.container)).toEqual(["Target"]);
    });
    const two = renderWithProviders(
      <MarkdownView slug="todou">
        {"[T-7](/projects/todou/issues/7)"}
      </MarkdownView>,
      client,
    );
    await waitFor(() => {
      expect(titlesOfSeven(two.container)).toEqual(["Target"]);
    });
  });

  it("keeps every title when the reader asks for it", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">{THRICE}</MarkdownView>,
      seeded({ show_repeated_ref_title: true }),
    );
    await waitFor(() => {
      expect(
        view.container.querySelectorAll("a[data-issue-link='7']"),
      ).toHaveLength(3);
    });
    expect(titlesOfSeven(view.container)).toEqual([
      "Target",
      "Target",
      "Target",
    ]);
  });

  it("leaves refs inside code alone", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"[T-7](/projects/todou/issues/7) then `T-7` and\n\n```\nT-7\n```\n"}
      </MarkdownView>,
      seeded(),
    );
    await waitFor(() => {
      expect(
        view.container.querySelectorAll("a[data-issue-link='7']"),
      ).toHaveLength(1);
    });
    expect(titlesOfSeven(view.container)).toEqual(["Target"]);
    expect(view.container.querySelector("code")?.textContent).toBe("T-7");
  });
});

/** The one link pointing at card 7, once the batched lookup has landed. */
const linkToSeven = (root: ParentNode) =>
  waitFor(() => {
    const el = root.querySelector("a[data-issue-link='7']");
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });

describe("a reference to the card being read (T-408)", () => {
  it("reads 'current' instead of a ref and a title", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou" issueNumber={7}>
        {"see [T-7](/projects/todou/issues/7)"}
      </MarkdownView>,
      seeded(),
    );
    const link = await linkToSeven(view.container);
    expect(link.textContent).toBe("current");
    expect(titlesOfSeven(view.container)).toEqual([""]);
    expect(view.container.textContent).not.toContain("T-7");
    // Losing the visible ref must not cost the tooltip its full spelling.
    expect(link.getAttribute("title")).toBe("T-7 Target (Todo)");
  });

  it("draws the title and the ref when the reader asks for every title", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou" issueNumber={7}>
        {"see [T-7](/projects/todou/issues/7)"}
      </MarkdownView>,
      seeded({ show_repeated_ref_title: true }),
    );
    const link = await linkToSeven(view.container);
    expect(link.textContent).toBe("T-7Target");
    expect(
      link.querySelector("[data-comment-ref], [data-comment-author]"),
    ).toBeNull();
    expect(link.querySelector(".comment-reference-body")).toBeNull();
  });

  it("leaves another card in the same document alone", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou" issueNumber={7}>
        {"[T-7](/projects/todou/issues/7) then [T-8](/projects/todou/issues/8)"}
      </MarkdownView>,
      seeded(),
    );
    const other = await waitFor(() => {
      const el = view.container.querySelector("a[data-issue-link='8']");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(other.textContent).toContain("Other");
    expect(other.textContent).toContain("T-8");
    expect(other.textContent).not.toContain("current");
  });

  it.each([false, true])(
    "shows only the short comment ref on the current card when repeated titles=%s",
    async (show_repeated_ref_title) => {
      const view = renderWithProviders(
        <MarkdownView slug="todou" issueNumber={7}>
          {"see [T-7#comment-42](/projects/todou/issues/7#comment-42)"}
        </MarkdownView>,
        seeded({ show_repeated_ref_title }),
      );
      const link = await waitFor(() => {
        const el = view.container.querySelector("a[data-comment-link='42']");
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      expect(link.textContent).toBe("#comment-42 by Alice");
      const scope = link.querySelector("[data-comment-ref]");
      const parts = [...link.querySelectorAll("[data-ref-part]")];
      expect(parts.map((part) => part.textContent).join("")).toBe(
        "#comment-42",
      );
      for (const part of parts) {
        expect(part.closest("[data-comment-ref]")).toBe(scope);
      }
      expect(link.querySelector("[data-comment-author]")?.textContent).toBe(
        " by Alice",
      );
      expect(scope?.contains(link.querySelector("[data-comment-author]"))).toBe(
        false,
      );
      expect(
        link.querySelector("[data-comment-title], [data-comment-decoration]"),
      ).toBeNull();
      expect(link.getAttribute("href")).toBe(
        "/projects/todou/issues/7#comment-42",
      );
      expect(link.textContent).not.toContain("T-7");
      expect(link.textContent).not.toContain("Target");
      expect(link.textContent).not.toContain("current");
    },
  );

  it("stays out of a document that never said which card it is on", async () => {
    const view = renderWithProviders(
      <MarkdownView slug="todou">
        {"see [T-7](/projects/todou/issues/7)"}
      </MarkdownView>,
      seeded(),
    );
    const link = await linkToSeven(view.container);
    expect(link.textContent).toContain("Target");
    expect(link.textContent).toContain("T-7");
    expect(link.textContent).not.toContain("current");
  });

  it("follows a reference written at the address this card moved from", async () => {
    const client = seeded();
    const moved: ResolvedIssueRef = {
      ...refItem(7, "Target"),
      at: { slug: "todou", number: 7 },
    };
    client.setQueryData(issueRefQuery("todou", 9).queryKey, moved);
    const view = renderWithProviders(
      <MarkdownView slug="todou" issueNumber={7}>
        {"see [T-9](/projects/todou/issues/9)"}
      </MarkdownView>,
      client,
    );
    const link = await linkToSeven(view.container);
    expect(link.textContent).toBe("current");
    expect(view.container.textContent).not.toContain("T-9");
  });
});
