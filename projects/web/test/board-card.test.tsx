import type { IssueListItem } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { BoardCardContent } from "../src/pages/board.tsx";
import { renderWithProviders } from "./render.tsx";

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

describe("BoardCardContent unread dot (#46)", () => {
  it("marks a card with foreign activity since last view", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={{ ...issue(0), unread: true }} />,
    );
    await view.findByText("issue 1");
    expect(view.getByTitle("new activity since you last viewed")).toBeTruthy();
  });

  it("stays quiet when the card is read", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(0)} />,
    );
    await view.findByText("issue 1");
    expect(view.queryByTitle("new activity since you last viewed")).toBeNull();
  });
});

describe("BoardCardContent spec badge (#53)", () => {
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
