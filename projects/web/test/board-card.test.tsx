import { fireEvent, waitFor, within } from "@testing-library/react";
import type {
  BoardRefPlacement,
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  RefPlacement,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { api } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueRow } from "../src/components/issue/issue-row.tsx";
import { BoardCardContent } from "../src/pages/board.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

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
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
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

describe("BoardCardContent ref placement (T-153, T-157)", () => {
  const client = (board: BoardRefPlacement, list: RefPlacement = "before") => {
    const c = testQueryClient();
    c.setQueryData(referenceConfigQuery("p").queryKey, {
      format: { prefix: "T", history: [] },
      autolinks: [],
    } satisfies ReferenceConfig);
    c.setQueryData(prefsQuery.queryKey, {
      show_weak_unread: true,
      ref_placement_list: list,
      ref_placement_board: board,
      ref_placement_detail: "before",
      ref_placement_reference: "before",
    } satisfies MePrefs);
    return c;
  };

  const renderCard = async (board: BoardRefPlacement, openQuestions = 0) => {
    const { container } = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(openQuestions)} />,
      client(board),
    );
    const view = within(container);
    const title = await view.findByText("issue 1");
    return { container, view, title, ref: view.getByText("T-1") };
  };

  /** True when `b` comes after `a` in document order. */
  const precedes = (a: Element, b: Element) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("gives the ref a line of its own by default", async () => {
    const { container, title, ref } = await renderCard("own_line");
    expect(title.contains(ref)).toBe(false);
    expect(ref.className).toContain("mt-0.5");
    expect(precedes(title, ref)).toBe(true);
    // A bare card is its title and that line — no meta row is spun up to
    // hold the ref, and none spends its margin.
    expect(container.querySelector(".mt-1\\.5")).toBeNull();
  });

  it("keeps that line above the meta row", async () => {
    const { container, title, ref } = await renderCard("own_line", 2);
    const meta = container.querySelector(".mt-1\\.5");
    expect(meta).not.toBeNull();
    expect(precedes(title, ref)).toBe(true);
    expect(precedes(ref, meta as Element)).toBe(true);
  });

  it("carries the ref inside the title link when set to before", async () => {
    const { title, ref } = await renderCard("before");
    expect(ref.parentElement).toBe(title);
  });

  it("keeps the ref on the meta row when set to after", async () => {
    const { container, title, ref } = await renderCard("after");
    expect(title.contains(ref)).toBe(false);
    expect(precedes(title, ref)).toBe(true);
    expect(container.querySelector(".mt-1\\.5")?.contains(ref)).toBe(true);
  });

  it("drops the emptied meta row rather than leaving its margin behind", async () => {
    const { container } = await renderCard("before");
    expect(container.querySelector(".mt-1\\.5")).toBeNull();
  });

  it("keeps the meta row for a card that still has badges", async () => {
    const { container } = await renderCard("before", 2);
    expect(container.querySelector(".mt-1\\.5")).not.toBeNull();
  });

  it("reads its own surface's key, not the list's (T-157)", async () => {
    const { container } = renderWithProviders(
      <>
        <BoardCardContent slug="p" issue={issue(0)} />
        <ul>
          <IssueRow slug="p" issue={issue(0)} />
        </ul>
      </>,
      client("own_line", "after"),
    );
    const view = within(container);
    await view.findAllByText("issue 1");
    const [card, row] = view.getAllByText("T-1");
    expect(card.className).toContain("mt-0.5");
    expect(row.className).toContain("shrink-0");
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
