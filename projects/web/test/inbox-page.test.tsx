import { fireEvent, waitFor } from "@testing-library/react";
import type { InboxItem, InboxPage as InboxPageData } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { InboxPage } from "../src/pages/inbox.tsx";
import { renderWithProviders } from "./render.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

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
    muted: null,
    blocked_by: [],
    blocks: [],
    moves: [],
    project: { slug, name: `Project ${slug}` },
    last_activity_at: "2026-01-02T00:00:00Z",
    pending_spec_review: false,
    mentions_you: false,
    ...overrides,
  };
}

function mockInbox(page: InboxPageData) {
  vi.spyOn(api, "getInbox").mockResolvedValue(page);
  vi.spyOn(api, "getMyPrefs").mockResolvedValue({
    show_weak_unread: true,
    ref_placement_list: "before",
    ref_placement_board: "own_line",
    ref_placement_detail: "before",
    ref_placement_reference: "before",
    boxed_ref_links: true,
    truncate_ref_title: true,
    show_repeated_ref_title: false,
  });
}

describe("InboxPage", () => {
  it("shows the potato empty state", async () => {
    mockInbox({ items: [], truncated: false });
    const view = renderWithProviders(<InboxPage />);
    expect(await view.findByText("收件箱清空了 🥔")).toBeTruthy();
  });

  it("renders groups with reason badges and row details", async () => {
    mockInbox({
      items: [
        makeItem("greenhouse", 42, {
          open_questions: 1,
          unread_comments: 3,
          muted: null,
          blocked_by: [],
          blocks: [],
        }),
        makeItem("potato-field", 18, {
          unread: false,
          unread_comments: 0,
          muted: null,
          blocked_by: [],
          blocks: [],
          pending_spec_review: true,
          spec_version: 2,
          spec_review_status: "unreviewed",
        }),
      ],
      truncated: false,
    });
    const view = renderWithProviders(<InboxPage />);

    expect(await view.findByText("Project greenhouse")).toBeTruthy();
    expect(await view.findByText("Project potato-field")).toBeTruthy();
    expect(await view.findByText("issue 42")).toBeTruthy();
    // The same badges the issue row and the board card wear, addressed the
    // same way board-card.test does — not an inbox-only vocabulary (T-116).
    expect(await view.findByTitle("1 unanswered question(s)")).toBeTruthy();
    expect(await view.findByTitle("spec v2 is awaiting review")).toBeTruthy();
    // The strong-unread row carries the T-81 button with its count.
    expect(
      await view.findByRole("button", {
        name: "3 new comments — mark as read",
      }),
    ).toBeTruthy();
  });

  it("keeps the reason badges out of the desktop-only meta group", async () => {
    mockInbox({
      items: [
        makeItem("a", 7, {
          open_questions: 2,
          pending_spec_review: true,
          spec_version: 4,
          spec_review_status: "unreviewed",
        }),
      ],
      truncated: false,
    });
    const view = renderWithProviders(<InboxPage />);

    // The status/time group is hidden below sm; a reason badge parked inside
    // it would vanish on the phone, where this page is mostly read (T-116).
    for (const title of [
      "2 unanswered question(s)",
      "spec v4 is awaiting review",
    ]) {
      const badge = await view.findByTitle(title);
      expect(badge.closest(".max-sm\\:hidden")).toBeNull();
    }
    expect(view.getByText("issue 7")).toBeTruthy();
  });

  it("filters by tab", async () => {
    mockInbox({
      items: [
        makeItem("a", 1, { unread_comments: 2 }),
        makeItem("a", 2, {
          unread: false,
          unread_comments: 0,
          pending_spec_review: true,
          spec_version: 1,
          spec_review_status: "unreviewed",
        }),
      ],
      truncated: false,
    });
    const view = renderWithProviders(<InboxPage />);
    expect(await view.findByText("issue 1")).toBeTruthy();
    expect(view.queryByText("issue 2")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Specs" }));
    await waitFor(() => expect(view.queryByText("issue 1")).toBeNull());
    expect(view.queryByText("issue 2")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Comments" }));
    await waitFor(() => expect(view.queryByText("issue 2")).toBeNull());
    expect(view.queryByText("issue 1")).toBeTruthy();
  });

  it("mentions truncation when a project was capped", async () => {
    mockInbox({ items: [makeItem("a", 1)], truncated: true });
    const view = renderWithProviders(<InboxPage />);
    expect(await view.findByText(/more unread than shown/)).toBeTruthy();
  });

  it("marks mentioned rows with an @, and only those", async () => {
    mockInbox({
      items: [makeItem("a", 1, { mentions_you: true }), makeItem("a", 2)],
      truncated: false,
    });
    const view = renderWithProviders(<InboxPage />);
    expect(await view.findByText("issue 1")).toBeTruthy();
    const badges = view.container.querySelectorAll("svg.lucide-at-sign");
    expect(badges).toHaveLength(1);
    const badge = badges[0] as SVGElement;
    // The badge sits on the mentioned row, not the other one.
    expect(badge.closest("li")?.textContent).toContain("issue 1");
  });
});

describe("InboxPage · load failure (T-376)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects the retry into the unified control and recovers", async () => {
    const get = vi
      .spyOn(api, "getInbox")
      .mockRejectedValueOnce(new Error("inbox feed gone"));
    vi.spyOn(api, "getMyPrefs").mockResolvedValue({
      show_weak_unread: true,
      ref_placement_list: "before",
      ref_placement_board: "own_line",
      ref_placement_detail: "before",
      ref_placement_reference: "before",
      boxed_ref_links: true,
      truncate_ref_title: true,
      show_repeated_ref_title: false,
    });
    const view = renderWithProviders(<InboxPage />);

    expect(await view.findByText(/Could not load the inbox/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    // The old control was underlined text; its label is gone for good.
    expect(view.queryByText("Try again")).toBeNull();

    get.mockResolvedValueOnce({ items: [], truncated: false });
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await view.findByText("收件箱清空了 🥔");
  });
});
