import { fireEvent, waitFor } from "@testing-library/react";
import type { IssueListItem, Status } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { IssueRow } from "../src/components/issue/issue-row.tsx";
import { renderWithProviders } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const status: Status = {
  id: 1,
  name: "Todo",
  category: "open",
  color: "#000000",
  position: 1,
  is_default: false,
};

const issue = (unread: boolean, unreadComments = 0): IssueListItem => ({
  id: 10,
  number: 1,
  title: "issue 1",
  status,
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
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread,
  unread_comments: unreadComments,
});

const renderRow = (unread: boolean, unreadComments = 0) =>
  renderWithProviders(
    <ul>
      <IssueRow slug="p" issue={issue(unread, unreadComments)} />
    </ul>,
  );

describe("IssueRow unread marker (T-46, T-77)", () => {
  it("shows the ring next to the number for event-only activity", async () => {
    const view = renderRow(true);
    await view.findByText("issue 1");
    expect(view.getByTitle("new activity since you last viewed")).toBeTruthy();
  });

  it("keeps the slot empty once read", async () => {
    const view = renderRow(false);
    await view.findByText("issue 1");
    expect(view.queryByTitle("new activity since you last viewed")).toBeNull();
  });

  it("swaps the ring for a count badge when comments are waiting", async () => {
    const view = renderRow(true, 12);
    await view.findByText("issue 1");
    const badge = view.getByTitle("12 new comments since you last viewed");
    expect(badge.textContent).toBe("12");
    expect(view.queryByTitle("new activity since you last viewed")).toBeNull();
  });

  it("caps the badge at 99+ but keeps the exact count in the tooltip", async () => {
    const view = renderRow(true, 127);
    await view.findByText("issue 1");
    const badge = view.getByTitle("127 new comments since you last viewed");
    expect(badge.textContent).toBe("99+");
  });

  it("uses the singular for a single new comment", async () => {
    const view = renderRow(true, 1);
    await view.findByText("issue 1");
    expect(
      view.getByTitle("1 new comment since you last viewed").textContent,
    ).toBe("1");
  });

  it("clears the marker in place from the mark-read button (T-81)", async () => {
    const spy = vi.spyOn(api, "markIssueRead").mockResolvedValue(undefined);
    const view = renderRow(true, 3);
    await view.findByText("issue 1");
    fireEvent.click(view.getByRole("button", { name: /mark as read/i }));
    await waitFor(() =>
      expect(
        view.queryByTitle("3 new comments since you last viewed"),
      ).toBeNull(),
    );
    expect(spy).toHaveBeenCalledWith("p", 1, {});
  });
});
