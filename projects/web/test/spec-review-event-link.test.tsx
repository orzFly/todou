import { waitFor } from "@testing-library/react";
import type { IssueListItem } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { issueRefQuery } from "../src/api/issue-refs.ts";
import { MarkdownView } from "../src/components/shared/markdown-view.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

// A resolvable parent makes accidentally treating an event URL as an issue
// reference observable: it would acquire the parent's rich chip and title.
const issue: IssueListItem = {
  id: 19,
  number: 19,
  title: "Confirmed spec parent",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author: {
    id: 1,
    login: "alice",
    display_name: "Alice",
    kind: "human",
    avatar_url: null,
    owner: null,
  },
  assignees: [],
  labels: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: 1,
  spec_review_status: "approved",
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  muted: null,
  blocked_by: [],
  blocks: [],
  moves: [],
};

describe("review event permalinks", () => {
  it("keeps event href and label ordinary even when the parent resolves", async () => {
    const client = testQueryClient();
    client.setQueryData(issueRefQuery("p", 19).queryKey, issue);
    const href = `${window.location.origin}/projects/p/issues/19#event-901`;
    const view = renderWithProviders(
      <MarkdownView slug="p">{`[review decision](${href})`}</MarkdownView>,
      client,
    );
    await waitFor(() => {
      const link = view.container.querySelector("a");
      expect(link?.getAttribute("href")).toBe(href);
      expect(link?.textContent).toBe("review decision");
      expect(link?.hasAttribute("data-issue-link")).toBe(false);
      expect(link?.querySelector("svg")).toBeNull();
    });
    expect(view.container.textContent).not.toContain(issue.title);
  });
});
