import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  Issue,
  TimelineComment,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingTitleBar } from "../src/components/issue/floating-title-bar.tsx";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { groupTimeline } from "../src/components/timeline/group-events.ts";
import { RevealAllEye } from "../src/components/timeline/reveal-all-eye.tsx";
import { RevealedRunsProvider } from "../src/components/timeline/revealed-runs.tsx";
import { Timeline } from "../src/components/timeline/timeline.tsx";
import { TimelineDivider } from "../src/components/timeline/timeline-divider.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * Hidden comments on the web (T-281): the placeholder, the four entries that
 * open one, and the two controls on a comment's own header.
 */

const author = {
  id: 1,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const comment = (
  id: number,
  over: { hidden?: boolean; body?: string } = {},
): TimelineComment => ({
  type: "comment",
  id,
  author,
  body: over.body ?? `body ${id}`,
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: over.hidden === true ? "2026-09-08T11:00:00Z" : null,
  agent_context: null,
});

const event = (id: number): TimelineItem => ({
  type: "event",
  id,
  event_type: "opened",
  actor: author,
  payload: {},
  created_at: "2026-09-08T10:30:00Z",
  agent_context: null,
});

const ISSUE: Issue = {
  id: 11,
  number: 7,
  title: "Fix the potato",
  body: "",
  status: {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 0,
    is_default: true,
  },
  author,
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
  body_edited_at: null,
  open_questions: 0,
  spec_version: null,
  spec_review_status: null,
  spec_unresolved_comments: 0,
  deleted_at: null,
  deleted_by: null,
  unread: false,
  unread_comments: 0,
  moves: [],
};

type Call = { url: string; method?: string; body?: string };

/**
 * One timeline page per request, so the whole card arrives at once and the
 * fold block never appears — the two collapses are independent, and only the
 * hidden one is under test here.
 */
function stubFetch(items: TimelineItem[], total = items.length): Call[] {
  const calls: Call[] = [];
  const page: TimelinePage = {
    items,
    prev_cursor: null,
    next_cursor: "c1",
    total_count: total,
  };
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(replyFor(url, page)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  return calls;
}

/** Everything a mounted comment and timeline read on the way to rendering. */
function replyFor(url: string, page: TimelinePage): unknown {
  if (url.includes("/timeline")) return page;
  if (url.includes("/comments/hide")) return { hidden: [101], unchanged: [] };
  if (url.includes("/references/config")) {
    return { format: { prefix: "T", history: [] }, autolinks: [] };
  }
  if (url.includes("/reference-directory")) {
    return { entries: [], contested: [], slug_entries: [] };
  }
  if (url.endsWith("/api/projects")) return [];
  if (url.includes("/labels") || url.includes("/statuses")) return [];
  if (url.includes("/members")) return [];
  return ISSUE;
}

afterEach(() => vi.unstubAllGlobals());

/** The page as far as hiding is concerned: the bar, the rule, the timeline. */
function renderPage(items: TimelineItem[], hash = "") {
  const calls = stubFetch(items);
  const view = renderWithProviders(
    <RevealedRunsProvider>
      <FloatingTitleBar
        slug="p"
        issue={ISSUE}
        watchTarget={{ current: null }}
        mirror={<RevealAllEye />}
      />
      <TimelineDivider />
      <Timeline
        slug="p"
        issueNumber={7}
        pendingComments={[]}
        viewer={{ id: 1, isAdmin: false, role: "writer" }}
      />
    </RevealedRunsProvider>,
    testQueryClient(),
    { initialEntry: `/${hash}` },
  );
  return { ...view, calls };
}

const timelineCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.includes("/timeline"));

describe("grouping hidden runs", () => {
  it("folds adjacent hidden comments and lets anything else break the run", () => {
    const units = groupTimeline([
      comment(101, { hidden: true }),
      comment(102, { hidden: true }),
      event(500),
      comment(103, { hidden: true }),
      comment(104),
    ]);
    expect(units.map((u) => u.kind)).toEqual([
      "hidden",
      "item",
      "hidden",
      "item",
    ]);
    expect(units[0]?.kind === "hidden" && units[0].comments.length).toBe(2);
    expect(units[2]?.kind === "hidden" && units[2].comments.length).toBe(1);
  });

  it("passes a revealed run through as ordinary items", () => {
    const items = [
      comment(101, { hidden: true }),
      comment(102, { hidden: true }),
      comment(103, { hidden: true }),
    ];
    // One run of three, keyed by its first comment.
    expect(groupTimeline(items, (key) => key === "hidden-101")).toEqual([
      { kind: "item", item: items[0] },
      { kind: "item", item: items[1] },
      { kind: "item", item: items[2] },
    ]);
  });

  it("reads a missing hidden_at as visible, not as hidden", () => {
    // Responses are cast, not parsed: a server predating T-281 sends no such
    // key, and every one of its comments must still render.
    const legacy = { ...comment(101) } as Record<string, unknown>;
    delete legacy.hidden_at;
    const units = groupTimeline([legacy as unknown as TimelineItem]);
    expect(units.map((u) => u.kind)).toEqual(["item"]);
  });
});

describe("the placeholder and the reveal entries", () => {
  it("renders one block per run and opens it without a request", async () => {
    const view = renderPage([
      comment(101, { hidden: true }),
      comment(102, { hidden: true }),
      event(500),
      comment(103, { hidden: true }),
      comment(104),
    ]);
    const blocks = await waitFor(() => {
      const found = view.container.querySelectorAll(
        "[data-testid='hidden-block']",
      );
      expect(found).toHaveLength(2);
      return found;
    });
    expect(blocks[0]?.textContent).toContain("2 hidden comments");
    expect(blocks[1]?.textContent).toContain("1 hidden comment");
    expect(view.queryByText("body 101")).toBeNull();

    const before = timelineCalls(view.calls).length;
    fireEvent.click(blocks[0]?.querySelector("button") as HTMLButtonElement);
    await waitFor(() => expect(view.getByText("body 101")).toBeTruthy());
    expect(view.getByText("body 102")).toBeTruthy();
    // Revealing is a view change; the bodies were already in hand.
    expect(timelineCalls(view.calls)).toHaveLength(before);
    // One-way: that placeholder is gone, the other stays.
    expect(
      view.container.querySelectorAll("[data-testid='hidden-block']"),
    ).toHaveLength(1);
  });

  it("asks the server for the bodies up front", async () => {
    const view = renderPage([comment(101, { hidden: true })]);
    await waitFor(() =>
      expect(timelineCalls(view.calls).length).toBeGreaterThan(0),
    );
    for (const call of timelineCalls(view.calls)) {
      expect(call.url).toContain("include_hidden=true");
    }
  });

  it("counts the card's hidden comments in the section rule and the bar", async () => {
    const view = renderPage([
      comment(101, { hidden: true }),
      event(500),
      comment(102, { hidden: true }),
      comment(103),
    ]);
    const rule = await waitFor(() => {
      const el = view.container.querySelector(
        "[data-testid='timeline-divider']",
      );
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(rule.textContent).toContain("timeline · 2 hidden comments");
    expect(view.getByTestId("reveal-all-eye").textContent).toContain("2");
  });

  it("keeps both out of the way on a card that hides nothing", async () => {
    const view = renderPage([comment(101), comment(102)]);
    await waitFor(() => expect(view.getByText("body 101")).toBeTruthy());
    expect(
      view.container.querySelector("[data-testid='timeline-divider']"),
    ).toBeNull();
    expect(view.queryByTestId("reveal-all-eye")).toBeNull();
  });

  it("opens every run from the section rule", async () => {
    const view = renderPage([
      comment(101, { hidden: true }),
      event(500),
      comment(102, { hidden: true }),
    ]);
    const rule = await waitFor(() =>
      view.getByRole("button", { name: "Reveal all" }),
    );
    fireEvent.click(rule);
    await waitFor(() => expect(view.getByText("body 101")).toBeTruthy());
    expect(view.getByText("body 102")).toBeTruthy();
    expect(
      view.container.querySelectorAll("[data-testid='hidden-block']"),
    ).toHaveLength(0);
  });

  it("opens every run from the bar without scrolling to the top", async () => {
    const view = renderPage([
      comment(101, { hidden: true }),
      event(500),
      comment(102, { hidden: true }),
    ]);
    const eye = await waitFor(() => view.getByTestId("reveal-all-eye"));
    const scrolled: unknown[] = [];
    vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
      scrolled.push(args);
    });

    fireEvent.click(eye);
    await waitFor(() => expect(view.getByText("body 101")).toBeTruthy());
    expect(view.getByText("body 102")).toBeTruthy();
    // The whole bar scrolls the page up when clicked; this button must not.
    expect(scrolled).toEqual([]);
  });
});

describe("a #comment anchor landing in a hidden run", () => {
  it("opens the run holding it and centers the target", async () => {
    const centered: unknown[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(
      this: Element,
      ...args: unknown[]
    ) {
      centered.push({ id: this.id, args });
    } as typeof Element.prototype.scrollIntoView;

    const view = renderPage(
      [
        comment(101, { hidden: true }),
        comment(102, { hidden: true }),
        comment(103),
      ],
      "#comment-102",
    );

    // The body appearing at all is the reveal: nothing else opens that run.
    await waitFor(() => expect(view.getByText("body 102")).toBeTruthy());
    await waitFor(() => {
      const target = view.container.querySelector("#comment-102");
      expect(target).not.toBeNull();
      expect(
        centered.some((c) => (c as { id: string }).id === "comment-102"),
      ).toBe(true);
    });
  });

  it("chains the paging gap and the run when the target is behind both", async () => {
    Element.prototype.scrollIntoView =
      (() => {}) as typeof Element.prototype.scrollIntoView;
    // The target is neither loaded nor visible: the gap has to be expanded
    // first, which turns it into a placeholder, which then has to be opened.
    const tail: TimelinePage = {
      items: [comment(200)],
      prev_cursor: "P",
      next_cursor: "c1",
      total_count: 5,
    };
    const pages: Record<string, TimelinePage> = {
      tail,
      head: {
        items: [comment(101)],
        prev_cursor: null,
        next_cursor: "h1",
        total_count: 5,
      },
      "after=h1": {
        items: [comment(102, { hidden: true }), comment(103, { hidden: true })],
        prev_cursor: null,
        next_cursor: "h2",
        total_count: 5,
      },
    };
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = String(input);
      const key = !url.includes("/timeline")
        ? null
        : url.includes("after=h1")
          ? "after=h1"
          : url.includes("last=1")
            ? "tail"
            : "head";
      const body = key === null ? replyFor(url, tail) : pages[key];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch);

    const view = renderWithProviders(
      <RevealedRunsProvider>
        <Timeline
          slug="p"
          issueNumber={7}
          pendingComments={[]}
          viewer={{ id: 1, isAdmin: false, role: "writer" }}
        />
      </RevealedRunsProvider>,
      testQueryClient(),
      { initialEntry: "/#comment-102" },
    );

    await waitFor(() => expect(view.getByText("body 102")).toBeTruthy(), {
      timeout: 3000,
    });
    expect(view.container.querySelector("#comment-102")).not.toBeNull();
  });
});

describe("a comment's own hide controls", () => {
  const render = (
    over: { hidden?: boolean },
    role: "reader" | "reporter" | "writer",
  ) => {
    const calls = stubFetch([]);
    const view = renderWithProviders(
      <CommentItem
        slug="p"
        issueNumber={7}
        comment={comment(101, over)}
        viewer={{ id: 1, isAdmin: false, role }}
      />,
      testQueryClient(),
    );
    return { ...view, calls };
  };

  it("shows the crossed-out eye on a hidden comment", async () => {
    const view = render({ hidden: true }, "writer");
    expect(
      await view.findByRole("button", { name: "unhide comment" }),
    ).toBeTruthy();
  });

  it("shows no such button on a comment nobody hid", async () => {
    const view = render({}, "writer");
    // Scoped to this render: the queries default to document.body, which a
    // sibling case's still-mounted tree would answer from.
    await waitFor(() =>
      expect(
        within(view.container).getByRole("button", {
          name: "comment actions",
        }),
      ).toBeTruthy(),
    );
    expect(
      within(view.container).queryByRole("button", { name: "unhide comment" }),
    ).toBeNull();
  });

  it("unhides for everyone when that button is pressed", async () => {
    const view = render({ hidden: true }, "writer");
    const button = await view.findByRole("button", { name: "unhide comment" });
    fireEvent.click(button);

    const write = await waitFor(() => {
      const call = view.calls.find((c) => c.url.includes("/comments/hide"));
      expect(call).toBeDefined();
      return call as Call;
    });
    expect(write.method).toBe("POST");
    expect(JSON.parse(write.body ?? "{}")).toEqual({
      hidden: false,
      comment_ids: [101],
    });
  });

  it("leaves the button as a mark for a reader who may not write", async () => {
    const view = render({ hidden: true }, "reader");
    const button = await view.findByRole("button", { name: "unhide comment" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(view.calls.filter((c) => c.url.includes("/hide"))).toEqual([]);
  });

  /** Radix opens on pointerdown, not on click. */
  const openMenu = async (view: ReturnType<typeof render>) => {
    const trigger = await waitFor(() =>
      within(view.container).getByRole("button", { name: "comment actions" }),
    );
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    return trigger;
  };

  it("offers Hide in the menu to a writer", async () => {
    const view = render({}, "writer");
    await openMenu(view);
    expect(screen.getByRole("menuitem", { name: /Hide comment/ })).toBeTruthy();
  });

  it("offers a reporter Delete but not Hide", async () => {
    // A reporter authoring their own comment still gets Edit and Delete —
    // hiding is the one entry the role decides.
    const view = render({}, "reporter");
    await openMenu(view);
    expect(
      screen.getByRole("menuitem", { name: /Delete comment/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Hide comment/ })).toBeNull();
  });

  it("hides for everyone from the menu", async () => {
    const view = render({}, "writer");
    await openMenu(view);
    fireEvent.click(screen.getByRole("menuitem", { name: /Hide comment/ }));

    const write = await waitFor(() => {
      const call = view.calls.find((c) => c.url.includes("/comments/hide"));
      expect(call).toBeDefined();
      return call as Call;
    });
    expect(JSON.parse(write.body ?? "{}")).toEqual({
      hidden: true,
      comment_ids: [101],
    });
  });

  it("confirms a delete, points at Hide, and hands focus back", async () => {
    const view = render({}, "writer");
    const trigger = await openMenu(view);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete comment/ }));

    const dialog = await screen.findByText(/cannot be brought back/);
    expect(dialog.textContent).toContain("Hide");
    // Nothing is written until the dialog is confirmed.
    expect(view.calls.filter((c) => c.method === "DELETE")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Radix restores focus to the menu item, which is gone — the component
    // puts it back on the trigger a frame later.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
