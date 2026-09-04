import { fireEvent, waitFor } from "@testing-library/react";
import type {
  InboxItem,
  InboxPage,
  IssueListItem,
  IssueListPage,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { clearAllUnread, clearInboxUnread } from "../src/api/reads.ts";
import { MarkAllReadButton } from "../src/components/issue/mark-all-read-button.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: { success: vi.fn(), error: vi.fn() },
}));
const { toast } = await import("sonner");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

const listItem = (
  number: number,
  overrides: Partial<IssueListItem> = {},
): IssueListItem => ({
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
  unread_comments: 2,
  moves: [],
  ...overrides,
});

const inboxItem = (
  slug: string,
  number: number,
  overrides: Partial<InboxItem> = {},
): InboxItem => ({
  ...listItem(number),
  project: { slug, name: `Project ${slug}` },
  last_activity_at: "2026-08-12T00:00:00Z",
  pending_spec_review: false,
  ...overrides,
});

describe("MarkAllReadButton (T-100)", () => {
  it("sweeps one project when given a slug", async () => {
    const spy = vi.spyOn(api, "markAllRead").mockResolvedValue(undefined);
    const view = renderWithProviders(
      <MarkAllReadButton slug="greenhouse" scopeName="this project" />,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ projects: ["greenhouse"] }),
    );
    expect(toast.success).toHaveBeenCalledWith("Marked this project as read");
  });

  it("sweeps everything readable when the slug is omitted", async () => {
    const spy = vi.spyOn(api, "markAllRead").mockResolvedValue(undefined);
    const view = renderWithProviders(
      <MarkAllReadButton scopeName="the inbox" />,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));
    // An empty body is the cross-project scope — not "no projects".
    await waitFor(() => expect(spy).toHaveBeenCalledWith({}));
  });

  it("clears the markers it can reach before the request settles", async () => {
    let release: () => void = () => {};
    vi.spyOn(api, "markAllRead").mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const client = testQueryClient();
    const key = ["issues", "greenhouse", {}];
    client.setQueryData<IssueListPage>(key, {
      items: [listItem(1), listItem(2)],
      next_cursor: null,
    });
    const view = renderWithProviders(
      <MarkAllReadButton slug="greenhouse" />,
      client,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));

    await waitFor(() => {
      const page = client.getQueryData<IssueListPage>(key);
      expect(page?.items.every((i) => !i.unread)).toBe(true);
    });
    release();
  });

  it("leaves neighbouring projects' caches alone", async () => {
    vi.spyOn(api, "markAllRead").mockResolvedValue(undefined);
    const client = testQueryClient();
    const other = ["issues", "orchard", {}];
    client.setQueryData<IssueListPage>(other, {
      items: [listItem(9)],
      next_cursor: null,
    });
    const view = renderWithProviders(
      <MarkAllReadButton slug="greenhouse" />,
      client,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(client.getQueryData<IssueListPage>(other)?.items[0]?.unread).toBe(
      true,
    );
  });

  it("restores the caches and toasts when the sweep fails", async () => {
    vi.spyOn(api, "markAllRead").mockRejectedValue(new Error("boom"));
    const client = testQueryClient();
    const key = ["issues", "greenhouse", {}];
    client.setQueryData<IssueListPage>(key, {
      items: [listItem(1)],
      next_cursor: null,
    });
    const view = renderWithProviders(
      <MarkAllReadButton slug="greenhouse" />,
      client,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not mark as read: boom"),
    );
    expect(client.getQueryData<IssueListPage>(key)?.items[0]?.unread).toBe(
      true,
    );
  });

  it("refreshes the inbox badge, which no event ever would (T-112)", async () => {
    vi.spyOn(api, "markAllRead").mockResolvedValue(undefined);
    const client = testQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const view = renderWithProviders(
      <MarkAllReadButton slug="greenhouse" />,
      client,
    );
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["inbox"] }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["issues", "greenhouse"] });
  });

  it("invalidates every project's list on a global sweep", async () => {
    vi.spyOn(api, "markAllRead").mockResolvedValue(undefined);
    const client = testQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const view = renderWithProviders(<MarkAllReadButton />, client);
    fireEvent.click(await view.findByRole("button", { name: /mark .* read/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["issues"] }),
    );
  });
});

describe("clearAllUnread", () => {
  it("clears every row on the page", () => {
    const page: IssueListPage = {
      items: [listItem(1), listItem(2, { unread_comments: 0 })],
      next_cursor: null,
    };
    for (const item of clearAllUnread(page).items) {
      expect(item).toMatchObject({ unread: false, unread_comments: 0 });
    }
  });
});

describe("clearInboxUnread", () => {
  const page = (): InboxPage => ({
    items: [
      inboxItem("greenhouse", 1),
      inboxItem("greenhouse", 2, { open_questions: 3 }),
      inboxItem("greenhouse", 3, { pending_spec_review: true }),
      inboxItem("orchard", 4),
    ],
    truncated: false,
  });

  it("drops rows whose only reason was unread activity", () => {
    const patched = clearInboxUnread(page(), "greenhouse");
    expect(patched.items.map((i) => i.number)).toEqual([2, 3, 4]);
  });

  it("keeps the other reasons but clears their markers", () => {
    const patched = clearInboxUnread(page(), "greenhouse");
    expect(patched.items[0]).toMatchObject({
      number: 2,
      unread: false,
      unread_comments: 0,
      open_questions: 3,
    });
    expect(patched.items[1]).toMatchObject({
      number: 3,
      unread: false,
      pending_spec_review: true,
    });
  });

  it("leaves projects outside the scope untouched", () => {
    const patched = clearInboxUnread(page(), "greenhouse");
    expect(patched.items.at(-1)).toMatchObject({
      number: 4,
      unread: true,
      unread_comments: 2,
    });
  });

  it("empties every project when the scope is global", () => {
    const patched = clearInboxUnread(page());
    expect(patched.items.map((i) => i.number)).toEqual([2, 3]);
  });
});
