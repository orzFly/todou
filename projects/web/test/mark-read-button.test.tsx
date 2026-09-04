import { fireEvent, waitFor } from "@testing-library/react";
import type { IssueListItem, IssueListPage } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { clearUnread } from "../src/api/reads.ts";
import { MarkReadButton } from "../src/components/issue/mark-read-button.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { toast } = await import("sonner");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(toast.error).mockClear();
});

const renderButton = (unread: boolean, unreadComments = 0) =>
  renderWithProviders(
    <MarkReadButton
      slug="p"
      number={7}
      unread={unread}
      unreadComments={unreadComments}
    />,
  );

describe("MarkReadButton (T-81)", () => {
  it("wraps the count badge and carries the count into its label", async () => {
    const view = renderButton(true, 3);
    const button = await view.findByRole("button", {
      name: "3 new comments — mark as read",
    });
    expect(button.textContent).toBe("3");
  });

  it("uses the singular for one comment", async () => {
    const view = renderButton(true, 1);
    expect(
      await view.findByRole("button", { name: "1 new comment — mark as read" }),
    ).toBeTruthy();
  });

  it("wraps the ring for event-only activity", async () => {
    const view = renderButton(true);
    expect(
      await view.findByRole("button", {
        name: "new activity — mark as read",
      }),
    ).toBeTruthy();
  });

  it("renders nothing once read", async () => {
    const view = renderButton(false);
    await waitFor(() =>
      expect(view.queryByRole("button", { name: /mark as read/i })).toBeNull(),
    );
  });

  it("fires the PUT and hides itself immediately on click", async () => {
    const spy = vi.spyOn(api, "markIssueRead").mockResolvedValue(undefined);
    const view = renderButton(true, 3);
    fireEvent.click(await view.findByRole("button", { name: /mark as read/i }));
    // Local state hides the marker before the request settles — this is
    // what keeps Load-more rows (whose data lives outside the query
    // cache) in sync.
    expect(view.queryByRole("button", { name: /mark as read/i })).toBeNull();
    await waitFor(() => expect(spy).toHaveBeenCalledWith("p", 7, {}));
  });

  it("brings the marker back and toasts when the request fails", async () => {
    vi.spyOn(api, "markIssueRead").mockRejectedValue(new Error("boom"));
    const view = renderButton(true, 3);
    fireEvent.click(await view.findByRole("button", { name: /mark as read/i }));
    await waitFor(() =>
      expect(
        view.queryByRole("button", { name: /mark as read/i }),
      ).toBeTruthy(),
    );
    expect(toast.error).toHaveBeenCalledWith("Could not mark as read: boom");
  });

  it("vanishes entirely for weak unread when the preference is off", async () => {
    const client = testQueryClient();
    client.setQueryData(["me-prefs"], { show_weak_unread: false });
    const view = renderWithProviders(
      <MarkReadButton slug="p" number={7} unread unreadComments={0} />,
      client,
    );
    // Marker AND click target go together — no invisible hoverable button.
    await waitFor(() =>
      expect(view.queryByRole("button", { name: /mark as read/i })).toBeNull(),
    );
  });

  it("keeps the count badge when the preference is off", async () => {
    const client = testQueryClient();
    client.setQueryData(["me-prefs"], { show_weak_unread: false });
    const view = renderWithProviders(
      <MarkReadButton slug="p" number={7} unread unreadComments={2} />,
      client,
    );
    expect(
      await view.findByRole("button", {
        name: "2 new comments — mark as read",
      }),
    ).toBeTruthy();
  });

  it("refreshes the inbox badge, which no event ever would (T-112)", async () => {
    // Read positions are eventless: neither SSE nor the /activity poll can
    // report them, so the badge only drops if the mutation says so.
    vi.spyOn(api, "markIssueRead").mockResolvedValue(undefined);
    const client = testQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const view = renderWithProviders(
      <MarkReadButton slug="p" number={7} unread unreadComments={2} />,
      client,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark as read/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["inbox"] }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "p"] });
  });

  it("does not let the click bubble into row/card handlers", async () => {
    vi.spyOn(api, "markIssueRead").mockResolvedValue(undefined);
    const outer = vi.fn();
    const view = renderWithProviders(
      // biome-ignore lint/a11y/useKeyWithClickEvents: bubbling probe only
      // biome-ignore lint/a11y/noStaticElementInteractions: bubbling probe only
      <div onClick={outer}>
        <MarkReadButton slug="p" number={7} unread unreadComments={2} />
      </div>,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark as read/i }));
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("clearUnread", () => {
  const item = (number: number, unreadComments: number): IssueListItem => ({
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
    created_at: "2026-08-12T00:00:00Z",
    updated_at: "2026-08-12T00:00:00Z",
    body_edited_at: null,
    open_questions: 0,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: true,
    unread_comments: unreadComments,
    moves: [],
  });

  it("clears only the matching row", () => {
    const page: IssueListPage = {
      items: [item(1, 3), item(2, 5)],
      next_cursor: null,
    };
    const patched = clearUnread(page, 1);
    expect(patched.items[0]).toMatchObject({
      unread: false,
      unread_comments: 0,
    });
    expect(patched.items[1]).toMatchObject({
      unread: true,
      unread_comments: 5,
    });
  });
});
