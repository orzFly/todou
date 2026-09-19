import type { InboxItem, SpecReviewStatus } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { unreadTotal } from "../src/api/inbox.ts";
import {
  inboxAttentionDiffers,
  inboxInvalidations,
} from "../src/api/useUserEvents.ts";
import { IssueRow } from "../src/components/issue/issue-row.tsx";
import { BoardCardContent } from "../src/pages/board.tsx";
import { matchesTab } from "../src/pages/inbox.tsx";
import { renderWithProviders } from "./render.tsx";

function item(reviewStatus: SpecReviewStatus): InboxItem {
  return {
    id: 7,
    number: 7,
    title: "spec lifecycle",
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
    updated_at: "2026-01-02T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: 2,
    spec_review_status: reviewStatus,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: true,
    unread_comments: 1,
    muted: null,
    blocked_by: [],
    blocks: [],
    moves: [],
    project: { id: 1, slug: "demo", name: "Demo" },
    last_activity_at: "2026-01-02T00:00:00Z",
    pending_spec_review: reviewStatus === "unreviewed",
    mentions_you: false,
  };
}

describe("withdrawal attention projections", () => {
  it.each(["list", "board"])(
    "removes only the pending spec badge from the %s surface",
    async (surface) => {
      for (const status of ["unreviewed", "withdrawn"] as const) {
        const issue = { ...item(status), open_questions: 1 };
        const view = renderWithProviders(
          surface === "list" ? (
            <IssueRow slug="demo" issue={issue} />
          ) : (
            <BoardCardContent slug="demo" issue={issue} />
          ),
        );
        await view.findByText("spec lifecycle");
        expect(view.queryByTitle("spec v2 is awaiting review") !== null).toBe(
          status === "unreviewed",
        );
        expect(view.getByTitle("1 unanswered question(s)")).toBeTruthy();
        view.unmount();
      }
    },
  );

  it("leaves unrelated unread in Inbox while excluding the withdrawn row from Specs", () => {
    const withdrawn = item("withdrawn");
    expect(matchesTab(item("unreviewed"), "specs")).toBe(true);
    expect(matchesTab(withdrawn, "specs")).toBe(false);
    expect(matchesTab(withdrawn, "comments")).toBe(true);
    expect(matchesTab(withdrawn, "all")).toBe(true);
    expect(
      unreadTotal({
        items: [withdrawn],
        truncated: false,
        unread_counts: { demo: 1 },
      }),
    ).toBe(1);
  });

  it("detects pending removal and an explicit null SSE row without clearing unrelated unread", () => {
    const pending = item("unreviewed");
    const withdrawn = item("withdrawn");
    expect(
      inboxAttentionDiffers({ items: [pending] }, "demo", 7, withdrawn),
    ).toBe(true);
    expect(
      inboxAttentionDiffers({ items: [withdrawn] }, "demo", 7, withdrawn),
    ).toBe(false);
    expect(inboxAttentionDiffers({ items: [pending] }, "demo", 7, null)).toBe(
      true,
    );
    expect(inboxAttentionDiffers({ items: [] }, "demo", 7, null)).toBe(false);
    expect(pending.unread_comments).toBe(1);
    expect(withdrawn.unread_comments).toBe(1);
  });

  it("carries an explicit absent Inbox row through the spec SSE invalidation", () => {
    expect(
      inboxInvalidations({
        entity: "spec",
        id: 7,
        action: "updated",
        project: "demo",
        issue_number: 7,
        inbox_row: null,
      }),
    ).toEqual([
      {
        key: ["inbox"],
        scope: { inboxRows: [{ project: "demo", number: 7, row: null }] },
      },
    ]);
  });
});
