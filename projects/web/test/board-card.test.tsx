import { fireEvent, waitFor } from "@testing-library/react";
import type { IssueListItem } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { BoardCardContent } from "../src/pages/board.tsx";
import { renderWithProviders } from "./render.tsx";

afterEach(() => vi.restoreAllMocks());

const issue = (
  open_questions: number,
  spec?: Pick<IssueListItem, "spec_version" | "spec_review_status">,
): IssueListItem => ({
  id: 10,
  number: 1,
  title: "issue 1",
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
  created_at: "2026-08-11T00:00:00Z",
  updated_at: "2026-08-11T00:00:00Z",
  body_edited_at: null,
  open_questions,
  spec_version: spec?.spec_version ?? null,
  spec_review_status: spec?.spec_review_status ?? null,
  spec_unresolved_comments: 0,
  unread: false,
  unread_comments: 0,
});

/* RouterProvider mounts asynchronously — wait for the title first. */
describe("BoardCardContent question badge", () => {
  it("shows the unanswered-question count when open_questions > 0", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(2)} />,
    );
    await view.findByText("issue 1");
    const badge = view.getByTitle("2 unanswered question(s)");
    expect(badge.textContent).toContain("2");
  });

  it("renders no badge when everything is answered", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(0)} />,
    );
    await view.findByText("issue 1");
    expect(view.queryByTitle(/unanswered/)).toBeNull();
  });
});

describe("BoardCardContent unread marker (T-46, T-77)", () => {
  it("marks a card with event-only activity with the ring", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={{ ...issue(0), unread: true }} />,
    );
    const title = await view.findByText("issue 1");
    expect(view.getByTitle("new activity since you last viewed")).toBeTruthy();
    expect(title.className).toContain("pr-4");
  });

  it("stays quiet when the card is read", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(0)} />,
    );
    const title = await view.findByText("issue 1");
    expect(view.queryByTitle("new activity since you last viewed")).toBeNull();
    expect(title.className).not.toContain("pr-4");
  });

  it("shows the comment-count badge and widens the title clearance", async () => {
    const view = renderWithProviders(
      <BoardCardContent
        slug="p"
        issue={{ ...issue(0), unread: true, unread_comments: 127 }}
      />,
    );
    const title = await view.findByText("issue 1");
    const badge = view.getByTitle("127 new comments since you last viewed");
    expect(badge.textContent).toBe("99+");
    expect(title.className).toContain("pr-8");
  });

  it("clears the corner marker in place from the mark-read button (T-81)", async () => {
    const spy = vi.spyOn(api, "markIssueRead").mockResolvedValue(undefined);
    const view = renderWithProviders(
      <BoardCardContent
        slug="p"
        issue={{ ...issue(0), unread: true, unread_comments: 2 }}
      />,
    );
    await view.findByText("issue 1");
    fireEvent.click(view.getByRole("button", { name: /mark as read/i }));
    await waitFor(() =>
      expect(
        view.queryByTitle("2 new comments since you last viewed"),
      ).toBeNull(),
    );
    expect(spy).toHaveBeenCalledWith("p", 1, {});
  });

  it("offers no mark-read button on a read card", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(0)} />,
    );
    await view.findByText("issue 1");
    expect(view.queryByRole("button", { name: /mark as read/i })).toBeNull();
  });
});

describe("BoardCardContent spec badge (T-53)", () => {
  it("shows the awaiting-review badge for an unreviewed spec", async () => {
    const view = renderWithProviders(
      <BoardCardContent
        slug="p"
        issue={issue(0, { spec_version: 3, spec_review_status: "unreviewed" })}
      />,
    );
    await view.findByText("issue 1");
    const badge = view.getByTitle("spec v3 is awaiting review");
    expect(badge.textContent).toContain("spec");
  });

  it("stays quiet once reviewed or without a spec", async () => {
    const reviewed = renderWithProviders(
      <BoardCardContent
        slug="p"
        issue={issue(0, { spec_version: 3, spec_review_status: "approved" })}
      />,
    );
    await reviewed.findByText("issue 1");
    expect(reviewed.queryByTitle(/awaiting review/)).toBeNull();

    const noSpec = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(0)} />,
    );
    await noSpec.findByText("issue 1");
    expect(noSpec.queryByTitle(/awaiting review/)).toBeNull();
  });
});
