import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { InboxItem, InboxPage as InboxPageData } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxQuery } from "../src/api/inbox.ts";
import { mutesQuery } from "../src/api/mutes.ts";
import { api } from "../src/api/queries.ts";
import { InboxPage } from "../src/pages/inbox.tsx";
import { render, renderWithProviders, testQueryClient } from "./render.tsx";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    project: { id: slug.length, slug, name: `Project ${slug}` },
    last_activity_at: "2026-01-02T00:00:00Z",
    pending_spec_review: false,
    mentions_you: false,
    ...overrides,
  };
}

type InboxFixture = Omit<InboxPageData, "unread_counts"> &
  Partial<Pick<InboxPageData, "unread_counts">>;

function inboxFixture(fixture: InboxFixture): InboxPageData {
  return { ...fixture, unread_counts: fixture.unread_counts ?? {} };
}

function mockInbox(fixture: InboxFixture): InboxPageData {
  const page = inboxFixture(fixture);
  vi.spyOn(api, "getMutes").mockResolvedValue({ issues: [], projects: [] });
  vi.spyOn(api, "getInbox").mockResolvedValue(page);
  vi.spyOn(api, "getReferenceDirectory").mockResolvedValue({
    entries: [
      {
        prefix: "GH",
        slug: "greenhouse",
        from: "2020-01-01T00:00:00.000Z",
        to: null,
      },
    ],
    contested: [],
  });
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
  return page;
}

// Exercise the page on both its production path and the shim's index path.
function renderInbox(initialEntry = "/inbox") {
  const client = testQueryClient();
  const rootRoute = createRootRoute();
  const routes = ["/", "/inbox"].map((path) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path,
      component: InboxPage,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
    client,
  };
}

function reasonItems(): InboxItem[] {
  const only = { unread: false, unread_comments: 0 };
  return [
    makeItem("b", 9, { ...only, mentions_you: true }),
    makeItem("a", 8, { unread_comments: 2 }),
    makeItem("b", 7, { ...only, pending_spec_review: true }),
    makeItem("a", 6, { ...only, open_questions: 1 }),
    makeItem("b", 5, { unread_comments: 3 }),
    makeItem("a", 4, { ...only, pending_spec_review: true }),
    makeItem("b", 3, { ...only, open_questions: 2 }),
    makeItem("a", 2, { ...only, mentions_you: true }),
    makeItem("b", 1, { ...only, mentions_you: true }),
  ];
}

function visibleGroups(container: HTMLElement) {
  return [...container.querySelectorAll("section")].map((section) => [
    within(section)
      .getByRole("link", { name: /Project / })
      .getAttribute("href"),
    within(section)
      .getAllByText(/^issue \d+$/)
      .map((row) => row.textContent),
  ]);
}

describe("InboxPage", () => {
  it("shows the potato empty state", async () => {
    mockInbox({ items: [], truncated: false });
    const view = renderWithProviders(<InboxPage />);
    expect(await view.findByText("收件箱清空了 🥔")).toBeTruthy();
    expect(view.queryByText("No issues match. 地里很干净 🥔")).toBeNull();
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

  it("draws the project's uploaded icon in the group header", async () => {
    class LoadedImage extends EventTarget {
      complete = true;
      naturalWidth = 20;
      crossOrigin: string | null = null;
      referrerPolicy = "";
      src = "";
    }
    vi.stubGlobal("Image", LoadedImage);
    const iconUrl = "/api/projects/1/icon?v=inbox";
    mockInbox({
      items: [
        makeItem("greenhouse", 42, {
          project: {
            id: 1,
            slug: "greenhouse",
            name: "Project greenhouse",
            icon_url: iconUrl,
          },
        }),
      ],
      truncated: false,
    });
    const view = renderWithProviders(<InboxPage />);

    const name = await view.findByText("Project greenhouse");
    expect(name.closest("a")?.querySelector("img")?.getAttribute("src")).toBe(
      iconUrl,
    );
  });

  it("falls back to the project's REF prefix in the group header", async () => {
    mockInbox({
      items: [makeItem("greenhouse", 42)],
      truncated: false,
    });
    const view = renderWithProviders(<InboxPage />);

    const name = await view.findByText("Project greenhouse");
    expect(name.closest("a")?.textContent).toContain("GH");
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
    const view = renderInbox();
    expect(await view.findByText("issue 1")).toBeTruthy();
    expect(view.queryByText("issue 2")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Specs" }));
    await waitFor(() => expect(view.queryByText("issue 1")).toBeNull());
    expect(view.queryByText("issue 2")).toBeTruthy();

    fireEvent.click(view.getByRole("tab", { name: "Comments" }));
    await waitFor(() => expect(view.queryByText("issue 2")).toBeNull());
    expect(view.queryByText("issue 1")).toBeTruthy();
  });

  it.each(["/?tab=mentions", "/inbox?tab=mentions"])(
    "selects Mentions from %s and exposes ordered accessible anchor tabs",
    async (initialEntry) => {
      mockInbox({ items: reasonItems(), truncated: false });
      const path = initialEntry.split("?")[0];
      const view = renderInbox(initialEntry);
      await view.findByText("issue 9");
      expect(visibleGroups(view.container)).toEqual([
        ["/projects/b", ["issue 9", "issue 1"]],
        ["/projects/a", ["issue 2"]],
      ]);
      const tabs = within(view.getByRole("tablist")).getAllByRole("tab");
      expect(
        tabs.map((tab) => [
          tab.textContent,
          tab.tagName,
          tab.getAttribute("href"),
          tab.getAttribute("aria-selected"),
        ]),
      ).toEqual([
        ["All", "A", path, "false"],
        ["Mentions", "A", `${path}?tab=mentions`, "true"],
        ["Comments", "A", `${path}?tab=comments`, "false"],
        ["Specs", "A", `${path}?tab=specs`, "false"],
        ["Questions", "A", `${path}?tab=questions`, "false"],
      ]);
      expect(view.router.state.location.href).toBe(initialEntry);
    },
  );

  it("navigates every reason tab, preserving grouping, row order and the inbox cache", async () => {
    const page = mockInbox({
      items: reasonItems(),
      truncated: true,
      unread_counts: { a: 73, b: 105 },
    });
    const original = structuredClone(page);
    const view = renderInbox();
    await view.findByText("issue 9");
    for (const [name, href, groups] of [
      [
        "Mentions",
        "/inbox?tab=mentions",
        [
          ["/projects/b", ["issue 9", "issue 1"]],
          ["/projects/a", ["issue 2"]],
        ],
      ],
      [
        "Comments",
        "/inbox?tab=comments",
        [
          ["/projects/a", ["issue 8"]],
          ["/projects/b", ["issue 5"]],
        ],
      ],
      [
        "Specs",
        "/inbox?tab=specs",
        [
          ["/projects/b", ["issue 7"]],
          ["/projects/a", ["issue 4"]],
        ],
      ],
      [
        "Questions",
        "/inbox?tab=questions",
        [
          ["/projects/a", ["issue 6"]],
          ["/projects/b", ["issue 3"]],
        ],
      ],
      [
        "All",
        "/inbox",
        [
          [
            "/projects/b",
            ["issue 9", "issue 7", "issue 5", "issue 3", "issue 1"],
          ],
          ["/projects/a", ["issue 8", "issue 6", "issue 4", "issue 2"]],
        ],
      ],
    ] as const) {
      fireEvent.click(view.getByRole("tab", { name }));
      await waitFor(() => {
        expect(view.router.state.location.href).toBe(href);
        expect(
          view.getByRole("tab", { name }).getAttribute("aria-selected"),
        ).toBe("true");
        expect(visibleGroups(view.container)).toEqual(groups);
      });
      expect(api.getInbox).toHaveBeenCalledTimes(1);
      expect(view.client.getQueryData(inboxQuery.queryKey)).toEqual(original);
      expect(page).toEqual(original);
    }
    expect(view.router.state.location.search).not.toHaveProperty("tab");
  });

  it.each(["/inbox?tab=bogus", "/inbox?tab=all"])(
    "shows every row for %s without rewriting the original URL",
    async (initialEntry) => {
      mockInbox({ items: reasonItems(), truncated: false });
      const view = renderInbox(initialEntry);
      await view.findByText("issue 9");
      expect(visibleGroups(view.container)).toEqual([
        [
          "/projects/b",
          ["issue 9", "issue 7", "issue 5", "issue 3", "issue 1"],
        ],
        ["/projects/a", ["issue 8", "issue 6", "issue 4", "issue 2"]],
      ]);
      expect(
        view.getByRole("tab", { name: "All" }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(view.router.state.location.href).toBe(initialEntry);
    },
  );

  it("keeps truncation and original counts when Mentions filters a nonempty inbox to nothing", async () => {
    const page = mockInbox({
      items: [makeItem("a", 1)],
      truncated: true,
      unread_counts: { a: 101 },
    });
    const original = structuredClone(page);
    const view = renderInbox();
    await view.findByText("issue 1");
    fireEvent.click(view.getByRole("tab", { name: "Mentions" }));
    await view.findByText("No issues match. 地里很干净 🥔");
    expect(view.queryByText("收件箱清空了 🥔")).toBeNull();
    expect(view.queryByText("issue 1")).toBeNull();
    expect(view.getByText(/more unread than shown/)).toBeTruthy();
    expect(view.router.state.location.href).toBe("/inbox?tab=mentions");
    expect(api.getInbox).toHaveBeenCalledTimes(1);
    expect(view.client.getQueryData(inboxQuery.queryKey)).toEqual(original);
    expect(page).toEqual(original);
  });

  it("does not infer truncation from rows hidden by the selected tab", async () => {
    mockInbox({
      items: [
        makeItem("a", 1, { mentions_you: true, unread_comments: 0 }),
        makeItem("a", 2),
      ],
      unread_counts: { a: 2 },
      truncated: false,
    });
    const view = renderInbox("/inbox?tab=mentions");
    await view.findByText("issue 1");
    expect(view.queryByText("issue 2")).toBeNull();
    expect(view.queryByText(/more unread than shown/)).toBeNull();
  });

  it("clears Mentions after Mark all read refetches, retaining other reasons in All", async () => {
    const item = makeItem("a", 1, { mentions_you: true, open_questions: 1 });
    mockInbox({ items: [item], truncated: false, unread_counts: { a: 1 } });
    const mark = vi.spyOn(api, "markAllRead").mockResolvedValue(undefined);
    const view = renderInbox("/inbox?tab=mentions");
    await view.findByText("issue 1");
    vi.mocked(api.getInbox).mockResolvedValue(
      inboxFixture({
        items: [
          { ...item, mentions_you: false, unread: false, unread_comments: 0 },
        ],
        truncated: false,
        unread_counts: { a: 1 },
      }),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Mark the inbox as read" }),
    );
    await view.findByText("No issues match. 地里很干净 🥔");
    expect(mark).toHaveBeenCalledWith({});
    expect(api.getInbox).toHaveBeenCalledTimes(2);
    expect(view.queryByText("issue 1")).toBeNull();
    fireEvent.click(view.getByRole("tab", { name: "All" }));
    await view.findByText("issue 1");
    expect(view.getByTitle("1 unanswered question(s)")).toBeTruthy();
  });

  it("shows only the full empty state when opening Mentions on an empty inbox", async () => {
    mockInbox({ items: [], truncated: false });
    const view = renderInbox("/inbox?tab=mentions");
    await view.findByText("收件箱清空了 🥔");
    expect(view.queryByText("No issues match. 地里很干净 🥔")).toBeNull();
    expect(
      view.getByRole("tab", { name: "Mentions" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("removes a row from Mentions when the shared inbox cache clears its mention", async () => {
    const item = makeItem("a", 1, { mentions_you: true, unread_comments: 2 });
    mockInbox({ items: [item], truncated: false });
    const view = renderInbox("/inbox?tab=mentions");
    await view.findByText("issue 1");
    // Existing read/SSE refreshes replace the shared payload; another reason
    // can keep the issue in Inbox after its unread mention has been cleared.
    const updated = inboxFixture({
      items: [{ ...item, mentions_you: false }],
      truncated: false,
      unread_counts: { a: 1 },
    });
    await act(async () => {
      view.client.setQueryData(inboxQuery.queryKey, updated);
    });
    await view.findByText("No issues match. 地里很干净 🥔");
    expect(view.queryByText("issue 1")).toBeNull();
    expect(view.queryByText("收件箱清空了 🥔")).toBeNull();
    expect(view.router.state.location.href).toBe("/inbox?tab=mentions");
    fireEvent.click(view.getByRole("tab", { name: "All" }));
    await view.findByText("issue 1");
    expect(view.client.getQueryData(inboxQuery.queryKey)).toEqual(updated);
    expect(api.getInbox).toHaveBeenCalledTimes(1);
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

  it("keeps the Muted link outside the reason tabs when the list is empty", async () => {
    mockInbox({ items: [], truncated: false });
    const view = renderWithProviders(<InboxPage />);
    const link = await view.findByRole("link", { name: "Muted" });
    expect(link.getAttribute("href")).toBe("/inbox/muted");
    expect(link.closest('[role="tablist"]')).toBeNull();
    expect(link.querySelector("span")).toBeNull();
    expect(view.queryByRole("tab", { name: /Muted/ })).toBeNull();
    expect(link.parentElement?.classList.contains("max-sm:ml-auto")).toBe(true);
    expect(link.parentElement?.textContent).toContain("Mark all read");
  });

  it("counts projects and issues with plain text, and updates with the shared cache", async () => {
    mockInbox({ items: [], truncated: false });
    const client = testQueryClient();
    const issue = {
      project: { slug: "p", name: "Project" },
      number: 7,
      title: "quiet",
      mode: "forever" as const,
      muted_at: "2026-01-01T00:00:00Z",
    };
    const mutes = {
      issues: [issue, { ...issue, number: 8 }],
      projects: [{ slug: "q", name: "Quiet", muted_at: issue.muted_at }],
    };
    vi.mocked(api.getMutes).mockResolvedValue(mutes);
    client.setQueryData(mutesQuery.queryKey, mutes);
    const view = renderWithProviders(<InboxPage />, client);
    const link = await view.findByRole("link", { name: "Muted 3" });
    expect(link.getAttribute("href")).toBe("/inbox/muted");
    expect(link.closest('[role="tablist"]')).toBeNull();
    expect(view.queryByRole("tab", { name: /Muted/ })).toBeNull();
    const count = link.querySelector("span");
    expect(count?.className).toBe("text-xs text-muted-foreground");
    expect(count?.getAttribute("title")).toBeNull();
    await act(async () => {
      client.setQueryData(mutesQuery.queryKey, {
        issues: [issue],
        projects: [],
      });
    });
    await view.findByRole("link", { name: "Muted 1" });
    await act(async () => {
      client.setQueryData(mutesQuery.queryKey, { issues: [], projects: [] });
    });
    expect(
      (await view.findByRole("link", { name: "Muted" })).querySelector("span"),
    ).toBeNull();
  });

  it.each(["pending", "failed"] as const)(
    "keeps the Muted link without a count when mutes are %s",
    async (state) => {
      mockInbox({ items: [], truncated: false });
      const get = vi.mocked(api.getMutes);
      if (state === "pending") {
        get.mockReturnValue(Promise.race([]));
      } else {
        get.mockRejectedValue(new Error("mutes unavailable"));
      }
      const client = testQueryClient();
      const view = renderWithProviders(<InboxPage />, client);
      const link = await view.findByRole("link", { name: "Muted" });
      if (state === "failed") {
        await waitFor(() =>
          expect(client.getQueryState(mutesQuery.queryKey)?.status).toBe(
            "error",
          ),
        );
      }
      expect(link.getAttribute("href")).toBe("/inbox/muted");
      expect(link.closest('[role="tablist"]')).toBeNull();
      expect(view.queryByRole("tab", { name: /Muted/ })).toBeNull();
      expect(link.querySelector("span")).toBeNull();
      expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(view.queryByText(/mutes unavailable/)).toBeNull();
    },
  );
});

describe("InboxPage · saved data (T-415)", () => {
  it("keeps an inbox issue on a failed refresh and Retry fetches new content", async () => {
    const cached = mockInbox({
      items: [makeItem("a", 42)],
      truncated: false,
    });
    const get = vi.mocked(api.getInbox);
    const client = testQueryClient();
    client.setQueryData(inboxQuery.queryKey, cached);
    const view = renderWithProviders(<InboxPage />, client);
    await view.findByText("issue 42");

    get.mockRejectedValue(
      Object.assign(new Error("feed unavailable"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: inboxQuery.queryKey });
    });
    await view.findByText(/Couldn't refresh the inbox/);
    expect(view.getByText("issue 42")).toBeTruthy();

    get.mockResolvedValue(
      inboxFixture({ items: [makeItem("a", 43)], truncated: false }),
    );
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await view.findByText("issue 43");
    expect(view.queryByText(/Couldn't refresh the inbox/)).toBeNull();
  });

  it("keeps the cold failure and its message visible during Retry, then clears it", async () => {
    mockInbox({ items: [], truncated: false });
    const get = vi.mocked(api.getInbox);
    get.mockRejectedValue(
      Object.assign(new Error("cold inbox unavailable"), { status: 500 }),
    );
    const view = renderWithProviders(<InboxPage />);
    await view.findByText(/Could not load the inbox: cold inbox unavailable/);

    let finish: (data: InboxPageData) => void = () => undefined;
    const retry = new Promise<InboxPageData>((resolve) => {
      finish = resolve;
    });
    get.mockReturnValue(retry);
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(
      view.getByText(/Could not load the inbox: cold inbox unavailable/),
    ).toBeTruthy();
    await act(async () => {
      finish(inboxFixture({ items: [makeItem("a", 44)], truncated: false }));
    });
    await view.findByText("issue 44");
    expect(view.queryByText(/Could not load the inbox/)).toBeNull();
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

    get.mockResolvedValueOnce(inboxFixture({ items: [], truncated: false }));
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await view.findByText("收件箱清空了 🥔");
  });
});
