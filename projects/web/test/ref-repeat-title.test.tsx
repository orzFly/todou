import type { QueryClient } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";
import type {
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  TimelineComment,
} from "@todou/shared";
import { describe, expect, it } from "vitest";
import { commentRefQuery, issueRefQuery } from "../src/api/issue-refs.ts";
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
  client.setQueryData(commentRefQuery("todou", 7, 42).queryKey, commentOf(42));
  client.setQueryData(prefsQuery.queryKey, { ...PREFS, ...overrides });
  return client;
}

/** The rendered title of every link pointing at card 7, in document order. */
const titlesOfSeven = (root: ParentNode): string[] =>
  [...root.querySelectorAll("a[data-issue-link='7']")].map((a) => {
    const label = [...a.children].find((c) =>
      (c.getAttribute("class") ?? "").includes("truncate"),
    );
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

  it("drops the title but keeps 'comment by X' on a repeat that is a comment link", async () => {
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
    expect(second?.textContent).toContain("comment by Alice");
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
