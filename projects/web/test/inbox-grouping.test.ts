import type { InboxItem } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { groupInboxItems } from "../src/api/inbox.ts";
import { matchesTab } from "../src/pages/inbox.tsx";

function makeItem(
  slug: string,
  number: number,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    id: number,
    number,
    title: `issue ${number}`,
    status: {
      id: 1,
      name: "Todo",
      category: "open",
      color: "#000000",
      position: 1,
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: true,
    unread_comments: 1,
    project: { slug, name: slug },
    last_activity_at: "2026-01-02T00:00:00Z",
    pending_spec_review: false,
    ...overrides,
  };
}

describe("groupInboxItems", () => {
  it("returns nothing for an empty inbox", () => {
    expect(groupInboxItems([])).toEqual([]);
  });

  it("groups by project, keeping the server's row order per group", () => {
    // Server order: newest first across projects.
    const items = [
      makeItem("b", 5, { last_activity_at: "2026-01-05T00:00:00Z" }),
      makeItem("a", 9, { last_activity_at: "2026-01-04T00:00:00Z" }),
      makeItem("b", 3, { last_activity_at: "2026-01-03T00:00:00Z" }),
      makeItem("a", 1, { last_activity_at: "2026-01-02T00:00:00Z" }),
    ];
    const groups = groupInboxItems(items);
    // First sighting of a project is its newest row, so group order
    // follows the newest row of each project.
    expect(groups.map((g) => g.project.slug)).toEqual(["b", "a"]);
    expect(groups[0]?.items.map((i) => i.number)).toEqual([5, 3]);
    expect(groups[1]?.items.map((i) => i.number)).toEqual([9, 1]);
  });
});

describe("matchesTab", () => {
  const weak = makeItem("p", 1, { unread_comments: 0 });
  const strong = makeItem("p", 2, { unread_comments: 4 });
  const spec = makeItem("p", 3, {
    unread: false,
    unread_comments: 0,
    pending_spec_review: true,
    spec_version: 2,
    spec_review_status: "unreviewed",
  });
  const question = makeItem("p", 4, {
    unread: false,
    unread_comments: 0,
    open_questions: 2,
  });

  it("all passes everything", () => {
    for (const item of [weak, strong, spec, question]) {
      expect(matchesTab(item, "all")).toBe(true);
    }
  });

  it("comments means foreign comments, not just any unread", () => {
    expect(matchesTab(strong, "comments")).toBe(true);
    expect(matchesTab(weak, "comments")).toBe(false);
  });

  it("specs and questions track their pending flags", () => {
    expect(matchesTab(spec, "specs")).toBe(true);
    expect(matchesTab(strong, "specs")).toBe(false);
    expect(matchesTab(question, "questions")).toBe(true);
    expect(matchesTab(spec, "questions")).toBe(false);
  });
});
