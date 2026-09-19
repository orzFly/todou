import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  BoardRefPlacement,
  IssueListItem,
  MePrefs,
  ReferenceConfig,
  RefPlacement,
  Status,
} from "@todou/shared";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardColumnQuery } from "../src/api/board.ts";
import { prefsQuery } from "../src/api/prefs.ts";
import { api, statusesQuery } from "../src/api/queries.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { IssueRow } from "../src/components/issue/issue-row.tsx";
import { BoardCardContent, BoardPage } from "../src/pages/board.tsx";
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
  muted: null,
  blocked_by: [],
  blocks: [],
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
      boxed_ref_links: true,
      truncate_ref_title: true,
      show_repeated_ref_title: false,
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

/**
 * happy-dom has no layout engine and loads no Tailwind, so the rule "no text
 * draws outside its own box" can only be pinned here by the classes that carry
 * it; the widths themselves were measured in a browser (T-303).
 */
describe("board contains long tokens (T-303)", () => {
  const LONG_TITLE = "CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1";
  const LONG_STATUS = "AwaitingUpstreamDependencyResolutionAndSignOff123";

  it("lets a title with no break point wrap inside the card", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={{ ...issue(0), title: LONG_TITLE }} />,
    );
    const title = await view.findByText(LONG_TITLE);
    expect(title.className).toContain("wrap-anywhere");
  });

  it("clips the meta row rather than letting a chip draw past the card", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(2)} />,
    );
    await view.findByText("issue 1");
    const meta = view.container.querySelector(".mt-1\\.5");
    expect(meta).not.toBeNull();
    expect((meta as Element).className).toContain("overflow-hidden");
  });

  it("truncates a long status name without squeezing its neighbours", async () => {
    const statuses: Status[] = [
      {
        id: 1,
        name: "Todo",
        category: "open",
        color: "#123456",
        position: 1,
        is_default: true,
      },
      {
        id: 2,
        name: LONG_STATUS,
        category: "open",
        color: "#a855f7",
        position: 2,
        is_default: false,
      },
    ];
    const client = testQueryClient();
    client.setQueryData(statusesQuery("p").queryKey, statuses);
    for (const status of statuses) {
      client.setQueryData(boardColumnQuery("p", status.id).queryKey, {
        items: [],
        next_cursor: null,
      });
    }
    client.setQueryData(referenceConfigQuery("p").queryKey, {
      format: { prefix: "T", history: [] },
      autolinks: [],
    } satisfies ReferenceConfig);

    // BoardPage reads its params strictly from "/authed/projects/$slug", so
    // the shim tree needs that same pathless "authed" id.
    const rootRoute = createRootRoute();
    const authedRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: "authed",
    });
    const projectRoute = createRoute({
      getParentRoute: () => authedRoute,
      path: "/projects/$slug",
    });
    const boardRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "board",
      component: () => (
        <Suspense fallback={<div>loading board</div>}>
          <BoardPage />
        </Suspense>
      ),
    });
    const issueRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number",
      component: () => <div>issue</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authedRoute.addChildren([
          projectRoute.addChildren([boardRoute, issueRoute]),
        ]),
      ]),
      history: createMemoryHistory({ initialEntries: ["/projects/p/board"] }),
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const name = await view.findByText(LONG_STATUS);
    const header = name.parentElement as HTMLElement;
    const [dot, , badge, category] = [...header.children] as HTMLElement[];
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("min-w-0");
    // Truncating the name alone would hand the shortfall to its neighbours,
    // and the count badge is the one that visibly collapses.
    for (const sibling of [dot, badge, category]) {
      expect(sibling.className).toContain("shrink-0");
    }
  });
});

/**
 * As in the block above, happy-dom can only pin the classes down. The geometry
 * they produce was measured in a browser: before the fix the badge was clipped
 * by 6.00px on the right and 2.77px at the bottom, and both read 0.00
 * afterwards (T-361).
 */
describe("board reserves room for the bot badge (T-361)", () => {
  const agent = {
    id: 2,
    login: "claude-agent",
    display_name: "Claude Agent",
    kind: "machine" as const,
    avatar_url: null,
    owner: { id: 1, login: "user" },
  };

  it("pads the meta row and the assignee cell around the badge's overhang", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={{ ...issue(0), assignees: [agent] }} />,
    );
    await view.findByText("issue 1");
    const meta = view.container.querySelector(".mt-1\\.5") as Element;
    expect(meta.className).toContain("pb-1");
    expect(meta.querySelector(".ml-auto")?.className).toContain("pr-1.5");
  });

  it("leaves the empty assignee cell at zero width", async () => {
    const view = renderWithProviders(
      <BoardCardContent slug="p" issue={issue(2)} />,
    );
    await view.findByText("issue 1");
    const meta = view.container.querySelector(".mt-1\\.5") as Element;
    expect(meta.querySelector(".ml-auto")?.className).not.toContain("pr-1.5");
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

describe.each(["board", "list"] as const)(
  "question links on %s (T-436)",
  (surface) => {
    const renderIssue = (count = 2) => {
      const item: IssueListItem = {
        ...issue(count, {
          spec_version: 3,
          spec_review_status: "unreviewed",
        }),
        blocked_by: [
          {
            edge_id: 7,
            project_id: 2,
            project: "other",
            number: 7,
            ref: "OTHER-7",
            hidden: false,
            cleared_at: null,
            blocker_deleted: false,
          },
        ],
      };
      return renderWithProviders(
        surface === "board" ? (
          <BoardCardContent slug="p" issue={item} />
        ) : (
          <ul>
            <IssueRow slug="p" issue={item} />
          </ul>
        ),
      );
    };

    it("C1 C3 exposes the complete name and href with only the icon hidden", async () => {
      const view = renderIssue();
      const link = await view.findByRole("link", {
        name: "2 unanswered question(s)",
      });
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(
        "/projects/p/issues/1#unanswered-questions",
      );
      expect(link.closest('[aria-hidden="true"]')).toBeNull();
      const pill = within(link).getByTitle("2 unanswered question(s)");
      expect(pill.textContent).toBe("2");
      expect(pill.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
        "true",
      );
      expect(link.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
      // Native Tab/Enter and the outline's geometry are checked in the browser.
      expect(link.tabIndex).toBe(0);
      link.focus();
      expect(document.activeElement).toBe(link);
    });

    it("C1 navigates a plain click to the issue's question hash", async () => {
      const view = renderIssue();
      fireEvent.click(
        await view.findByRole("link", { name: "2 unanswered question(s)" }),
      );
      await waitFor(() => {
        expect(view.router.state.location.pathname).toBe(
          "/projects/p/issues/1",
        );
        expect(view.router.state.location.hash).toBe("unanswered-questions");
      });
    });

    it.each([
      { gesture: "meta-click", type: "click", init: { metaKey: true } },
      { gesture: "ctrl-click", type: "click", init: { ctrlKey: true } },
      { gesture: "shift-click", type: "click", init: { shiftKey: true } },
      { gesture: "alt-click", type: "click", init: { altKey: true } },
      { gesture: "middle click", type: "click", init: { button: 1 } },
      { gesture: "middle auxclick", type: "auxclick", init: { button: 1 } },
      { gesture: "context menu", type: "contextmenu", init: { button: 2 } },
    ])("C1 preserves native $gesture", async ({ type, init }) => {
      const view = renderIssue();
      const link = await view.findByRole("link", {
        name: "2 unanswered question(s)",
      });
      const href = "/projects/p/issues/1#unanswered-questions";
      expect(link.getAttribute("href")).toBe(href);
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      await act(async () => {
        fireEvent(link, event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(view.router.state.location.pathname).toBe("/");
      expect(view.router.state.location.hash).toBe("");
      expect(link.getAttribute("href")).toBe(href);
    });

    it("C2 keeps question, spec and blocked badges outside the real title anchor", async () => {
      const view = renderIssue();
      const question = await view.findByRole("link", {
        name: "2 unanswered question(s)",
      });
      const title = view.getByRole("link", { name: /issue 1/ });
      const spec = view.getByRole("link", { name: "spec" });
      const blocked = view.getByTitle("waiting for 1 other issue(s)");
      expect(title.getAttribute("href")).toBe("/projects/p/issues/1");
      expect(spec.getAttribute("href")).toBe("/projects/p/issues/1/spec");
      expect(view.container.querySelectorAll("a a")).toHaveLength(0);
      for (const badge of [question, spec, blocked]) {
        expect(title.contains(badge)).toBe(false);
        expect(badge.parentElement?.closest("a")).toBeNull();
      }
      expect(question.contains(spec)).toBe(false);
      expect(question.contains(blocked)).toBe(false);
      expect(blocked.closest("a")).toBeNull();
    });

    it("C4 hides zero questions while preserving spec and blocked badges", async () => {
      const view = renderIssue(0);
      await view.findByRole("link", { name: /issue 1/ });
      expect(
        view.queryByRole("link", { name: /unanswered question/ }),
      ).toBeNull();
      expect(view.queryByTitle(/unanswered question/)).toBeNull();
      expect(
        view.getByRole("link", { name: "spec" }).getAttribute("href"),
      ).toBe("/projects/p/issues/1/spec");
      expect(view.getByTitle("waiting for 1 other issue(s)")).toBeTruthy();
    });

    it("C4 does not request questions on render, hover or focus", async () => {
      const questions = vi
        .spyOn(api, "getIssueQuestions")
        .mockResolvedValue({ items: [], open: 0 });
      const view = renderIssue();
      const link = await view.findByRole("link", {
        name: "2 unanswered question(s)",
      });
      await act(async () => {
        fireEvent.mouseEnter(link);
        fireEvent.focusIn(link);
      });
      expect(questions).not.toHaveBeenCalled();
    });

    it("C14 preserves the blocked preview and its target beside the question link", async () => {
      vi.spyOn(api, "listIssues").mockResolvedValue({
        items: [{ ...issue(0), id: 70, number: 7, title: "Prerequisite" }],
        next_cursor: null,
      });
      const view = renderIssue();
      const question = await view.findByRole("link", {
        name: "2 unanswered question(s)",
      });
      const trigger = view.getByTitle("waiting for 1 other issue(s)");
      fireEvent.pointerOver(trigger, { pointerType: "mouse", bubbles: true });
      const target = await view.findByRole("link", { name: /Prerequisite/ });
      expect(target.getAttribute("href")).toBe("/projects/other/issues/7");
      const popup = target.closest("[data-slot='hover-card-content']");
      expect(popup).not.toBeNull();
      expect(question.contains(popup)).toBe(false);
      expect(popup?.closest("a")).toBeNull();
      expect(target.parentElement?.closest("a")).toBeNull();
      expect(document.querySelectorAll("a a")).toHaveLength(0);
      fireEvent.pointerOut(trigger, {
        pointerType: "mouse",
        bubbles: true,
        relatedTarget: document.body,
      });
      await waitFor(() => expect(view.queryByText("Blocked by")).toBeNull());
      expect(question.getAttribute("href")).toBe(
        "/projects/p/issues/1#unanswered-questions",
      );
    });
  },
);

describe("BoardPage question links and drag overlay (T-436)", () => {
  function renderBoard() {
    const item = {
      ...issue(2, { spec_version: 3, spec_review_status: "unreviewed" }),
      number: 42,
      title: "Board question",
    };
    const client = testQueryClient();
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    });
    client.setQueryData(statusesQuery("greenhouse").queryKey, [item.status]);
    client.setQueryData(
      boardColumnQuery("greenhouse", item.status.id).queryKey,
      { items: [item], next_cursor: null },
    );
    client.setQueryData(referenceConfigQuery("greenhouse").queryKey, {
      format: { prefix: "GH", history: [] },
      autolinks: [],
    } satisfies ReferenceConfig);
    vi.spyOn(api, "getMutes").mockResolvedValue({ issues: [], projects: [] });
    const questions = vi
      .spyOn(api, "getIssueQuestions")
      .mockResolvedValue({ items: [], open: 0 });

    // BoardPage's strict useParams and its real PointerSensor need the app's
    // route ancestry. No DnD mock: activating the sensor mounts the real overlay.
    const rootRoute = createRootRoute();
    const authedRoute = createRoute({
      getParentRoute: () => rootRoute,
      id: "authed",
    });
    const projectRoute = createRoute({
      getParentRoute: () => authedRoute,
      path: "/projects/$slug",
    });
    const boardRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "board",
      component: () => (
        <Suspense fallback={<div>loading board</div>}>
          <BoardPage />
        </Suspense>
      ),
    });
    const issueRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number",
    });
    const specRoute = createRoute({
      getParentRoute: () => projectRoute,
      path: "issues/$number/spec",
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        authedRoute.addChildren([
          projectRoute.addChildren([boardRoute, issueRoute, specRoute]),
        ]),
      ]),
      history: createMemoryHistory({
        initialEntries: ["/projects/greenhouse/board"],
      }),
    });
    return {
      ...render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
      router,
      questions,
    };
  }

  const pointer = {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
  };

  it("C14 navigates a question click below the real drag threshold", async () => {
    const view = renderBoard();
    const link = await view.findByRole("link", {
      name: "2 unanswered question(s)",
    });
    fireEvent.pointerDown(link, pointer);
    fireEvent.pointerMove(document, { ...pointer, clientX: 14 });
    expect(
      view.getAllByRole("link", { name: "2 unanswered question(s)" }),
    ).toHaveLength(1);
    fireEvent.pointerUp(document, { ...pointer, buttons: 0, clientX: 14 });
    fireEvent.click(link);
    await waitFor(() => {
      expect(view.router.state.location.pathname).toBe(
        "/projects/greenhouse/issues/42",
      );
      expect(view.router.state.location.hash).toBe("unanswered-questions");
    });
    expect(view.questions).not.toHaveBeenCalled();
  });

  it("C2 C14 gives the real overlay the same href and suppresses the post-drag click", async () => {
    const view = renderBoard();
    const original = await view.findByRole("link", {
      name: "2 unanswered question(s)",
    });
    const href = "/projects/greenhouse/issues/42#unanswered-questions";
    expect(original.getAttribute("href")).toBe(href);
    fireEvent.pointerDown(original, pointer);
    fireEvent.pointerMove(document, { ...pointer, clientX: 30 });
    await waitFor(() => {
      expect(
        view.getAllByRole("link", { name: "2 unanswered question(s)" }),
      ).toHaveLength(2);
    });

    const questions = view.getAllByRole("link", {
      name: "2 unanswered question(s)",
    });
    const titles = view.getAllByRole("link", { name: /Board question/ });
    expect(titles).toHaveLength(2);
    for (const link of questions) {
      expect(link.getAttribute("href")).toBe(href);
      expect(link.closest('[aria-hidden="true"]')).toBeNull();
      expect(link.parentElement?.closest("a")).toBeNull();
      for (const title of titles) expect(title.contains(link)).toBe(false);
    }
    for (const spec of view.getAllByRole("link", { name: "spec" })) {
      expect(spec.getAttribute("href")).toBe(
        "/projects/greenhouse/issues/42/spec",
      );
      expect(spec.parentElement?.closest("a")).toBeNull();
    }
    expect(view.container.querySelectorAll("a a")).toHaveLength(0);
    expect(view.questions).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      fireEvent.pointerUp(document, { ...pointer, buttons: 0, clientX: 30 });
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      fireEvent(original, click);
      // dnd-kit stops propagation, but only BoardPage's window capture cancels
      // the anchor's native default navigation. Router state alone misses that.
      expect(click.defaultPrevented).toBe(true);
      expect(view.router.state.location.pathname).toBe(
        "/projects/greenhouse/board",
      );
      expect(view.router.state.location.hash).toBe("");
    } finally {
      // The real sensor retains its document click listener for 50ms after
      // release. Drain that teardown so it cannot swallow the next test's click.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      vi.useRealTimers();
    }
    await waitFor(() => {
      expect(
        view.getAllByRole("link", { name: "2 unanswered question(s)" }),
      ).toHaveLength(1);
    });
  });
});

describe.each(["board", "list"] as const)(
  "spec links on %s (T-421)",
  (surface) => {
    const renderIssue = () => {
      const item = issue(0, {
        spec_version: 3,
        spec_review_status: "unreviewed",
      });
      return renderWithProviders(
        surface === "board" ? (
          <BoardCardContent slug="p" issue={item} />
        ) : (
          <ul>
            <IssueRow slug="p" issue={item} />
          </ul>
        ),
      );
    };

    it("renders a real spec href for the card", async () => {
      const view = renderIssue();
      const link = await view.findByRole("link", { name: "spec" });
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe("/projects/p/issues/1/spec");
    });

    it("navigates a plain click to the spec page", async () => {
      const view = renderIssue();
      fireEvent.click(await view.findByRole("link", { name: "spec" }));
      await waitFor(() =>
        expect(view.router.state.location.pathname).toBe(
          "/projects/p/issues/1/spec",
        ),
      );
    });

    it("leaves modified and middle clicks to the browser", async () => {
      const view = renderIssue();
      const link = await view.findByRole("link", { name: "spec" });
      for (const init of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
        { button: 1 },
      ]) {
        const event = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        fireEvent(link, event);
        expect(event.defaultPrevented).toBe(false);
        expect(view.router.state.location.pathname).toBe("/");
      }
      const middle = new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      });
      fireEvent(link, middle);
      expect(middle.defaultPrevented).toBe(false);
      expect(view.router.state.location.pathname).toBe("/");
    });

    it("keeps the spec link outside the issue title link", async () => {
      const view = renderIssue();
      const spec = await view.findByRole("link", { name: "spec" });
      const title = view.getByRole("link", { name: /issue 1/ });
      expect(title.getAttribute("href")).toBe("/projects/p/issues/1");
      expect(title.contains(spec)).toBe(false);
      expect(spec.parentElement?.closest("a")).toBeNull();
      expect(view.container.querySelector("a a")).toBeNull();
    });
  },
);

describe("BoardCardContent assignees reach their own pages (T-391)", () => {
  const person = (id: number, login: string, name: string) => ({
    id,
    login,
    display_name: name,
    kind: "human" as const,
    avatar_url: null,
    owner: null,
  });

  it("links each assignee's avatar and gives it a readable name", async () => {
    const view = renderWithProviders(
      <BoardCardContent
        slug="p"
        issue={{
          ...issue(0),
          assignees: [
            person(2, "alice", "Alice Liu"),
            person(3, "bob", "Bob Ray"),
          ],
        }}
      />,
    );
    await view.findByText("issue 1");

    // User addresses only — the card's other anchor is its title. Two logins,
    // so neither avatar's link can stand in for the other's.
    const links = [...view.container.querySelectorAll('a[href^="/users/"]')];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/users/alice",
      "/users/bob",
    ]);
    // Nothing else on a board card says who it is assigned to: the avatar's
    // `alt` is empty and the fallback carries initials only.
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Alice Liu",
      "Bob Ray",
    ]);
  });
});
