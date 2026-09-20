import { act, fireEvent, waitFor, within } from "@testing-library/react";
import {
  type ActivityCard,
  type ActivityDay,
  ActivitySelection,
  MePrefs,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefsQuery } from "../src/api/prefs.ts";
import { referenceConfigQuery } from "../src/api/references.ts";
import { ActivityCalendar } from "../src/components/activity-calendar/activity-calendar.tsx";
import {
  ActivityCardList,
  type ActivityCardListProps,
} from "../src/components/activity-calendar/activity-card-list.tsx";
import { renderWithProviders, testQueryClient } from "./render.tsx";

/**
 * The shared row resolves a ref from the project's reference config, the way
 * every other issue list does, so the prefix is seeded per slug rather than
 * carried on each card.
 */
function seedPrefixes(
  client: ReturnType<typeof testQueryClient>,
  prefixes: Record<string, string | null>,
) {
  // The row reads the viewer's ref placement too; seeding it keeps these
  // assertions about the list rather than about an unseeded preferences fetch.
  client.setQueryData(prefsQuery.queryKey, MePrefs.parse({}));
  for (const [slug, prefix] of Object.entries(prefixes)) {
    client.setQueryData(referenceConfigQuery(slug).queryKey, {
      format: { prefix, history: [] },
      autolinks: [],
    });
  }
}

afterEach(() => vi.restoreAllMocks());

// Minimal DTOs: no IssueListItem author, labels, unread state or mutation metadata.
// IDs, issue numbers, project slugs and names deliberately differ.
const alpha: ActivityCard = {
  issue_id: 907,
  number: 42,
  title: "Repair the scheduler",
  project: {
    id: 61,
    slug: "alpha-engine",
    name: "Alpha Engine",
    issue_prefix: "AX",
  },
  status: {
    id: 8,
    name: "In review",
    category: "open",
    color: "#8844cc",
    position: 2,
    is_default: false,
  },
  url: "/projects/alpha-engine/issues/42",
  last_active_at: "2026-07-02T00:30:00Z",
};
const beta: ActivityCard = {
  issue_id: 907,
  number: 42,
  title: "Publish the package",
  project: {
    id: 73,
    slug: "beta-tools",
    name: "Beta Tools",
    issue_prefix: null,
  },
  status: {
    id: 19,
    name: "Done",
    category: "closed",
    color: "#228844",
    position: 4,
    is_default: false,
  },
  url: "/projects/beta-tools/issues/42",
  last_active_at: "2026-07-02T01:45:00Z",
};
const nextCard: ActivityCard = {
  ...alpha,
  issue_id: 155,
  number: 7,
  title: "Document the queue",
  url: "/projects/alpha-engine/issues/7",
};
const selection: ActivitySelection = {
  date: "2026-07-02",
  total: 17,
  items: [alpha, beta],
  next_cursor: "page-2",
  has_more: true,
};

// The real helper owns the router. A stateful child lets updates preserve that
// router and DOM, so identity assertions detect index/number keys and remounts.
function mount(
  overrides: Partial<ActivityCardListProps> = {},
  prefixes: Record<string, string | null> = {
    "alpha-engine": "AX",
    "beta-tools": null,
  },
) {
  const initial: ActivityCardListProps = {
    selection,
    timezone: "UTC",
    onLoadMore: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  let setProps: (props: ActivityCardListProps) => void;
  function Harness() {
    const [props, update] = useState(initial);
    setProps = update;
    return <ActivityCardList {...props} />;
  }
  const client = testQueryClient();
  seedPrefixes(client, prefixes);
  const view = renderWithProviders(<Harness />, client);
  return {
    ...view,
    client,
    update: (overrides: Partial<ActivityCardListProps>) =>
      act(() => setProps({ ...initial, ...overrides })),
  };
}

// Fixed local wall-clock instants, formatted in the runner's locale. Expectations
// below spell out the timezone conversion independently of the component.
function wallTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

describe("ActivityCalendar and ActivityCardList shared selection", () => {
  it("agrees on three selected cards and preserves project-local identities on reorder", async () => {
    const shared: ActivitySelection = {
      date: "2026-07-02",
      total: 3,
      items: [alpha, beta, nextCard],
      has_more: false,
      next_cursor: null,
    };
    const days: ActivityDay[] = Array.from({ length: 365 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1))
        .toISOString()
        .slice(0, 10);
      return { date, state: "recorded", count: date === "2026-07-02" ? 3 : 0 };
    });
    let updateSelection: (value: ActivitySelection) => void;
    function Combined() {
      const [current, update] = useState(shared);
      updateSelection = update;
      return (
        <>
          <ActivityCalendar
            from="2026-01-01"
            to="2027-01-01"
            days={days}
            selection={current}
            today="2026-09-19"
            onDayChange={vi.fn()}
            onRetry={vi.fn()}
          />
          <ActivityCardList
            selection={current}
            timezone="UTC"
            onLoadMore={vi.fn()}
            onRetry={vi.fn()}
          />
        </>
      );
    }
    const view = renderWithProviders(<Combined />);
    const tile = await view.findByRole("button", {
      name: "2026-07-02: 3 active cards",
    });
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    // Three is the busiest day on screen, so it lands in the top bucket.
    expect(tile.getAttribute("data-level")).toBe("3");
    const list = within(
      view.getByRole("region", { name: "Selected day activity" }),
    );
    expect(list.getByText("3 active cards")).not.toBeNull();
    expect(list.queryByText("2 active cards")).toBeNull();
    expect(list.getAllByRole("listitem")).toHaveLength(3);
    const links = list.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/alpha-engine/issues/42",
      "/projects/beta-tools/issues/42",
      "/projects/alpha-engine/issues/7",
    ]);
    expect(list.getAllByText("Alpha Engine")).toHaveLength(2);
    expect(list.getAllByText("Beta Tools")).toHaveLength(1);
    act(() => updateSelection({ ...shared, items: [beta, nextCard, alpha] }));
    const reordered = list.getAllByRole("link");
    expect(reordered).toHaveLength(3);
    expect(reordered[0]).toBe(links[1]);
    expect(reordered[1]).toBe(links[2]);
    expect(reordered[2]).toBe(links[0]);
    expect(tile.getAttribute("aria-label")).toBe("2026-07-02: 3 active cards");
    expect(
      view.queryByText(/annual|year total|history quality|incomplete/i),
    ).toBeNull();
  });
});

describe("ActivityCardList cards", () => {
  it("renders the minimal DTO in input order with the selected-day total and no invented metadata", async () => {
    expect(ActivitySelection.safeParse(selection).success).toBe(true);
    const fetch = vi.spyOn(globalThis, "fetch");
    const view = mount();
    await view.findByRole("link", { name: alpha.title });
    const cards = view.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(view.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Repair the scheduler",
      "Publish the package",
    ]);
    expect(view.getByRole("heading").textContent).toBe("2026-07-02");
    expect(view.getByText("17 active cards")).not.toBeNull();
    expect(view.queryByText("2 active cards")).toBeNull();
    expect(view.queryByText("34 active cards")).toBeNull();

    expect(cards[0].textContent).toBe(
      `AX-42Repair the schedulerAlpha EngineIn review${wallTime("2026-07-02T00:30:00Z")}`,
    );
    expect(cards[1].textContent).toBe(
      `#42Publish the packageBeta ToolsDone${wallTime("2026-07-02T01:45:00Z")}`,
    );
    for (const card of cards) {
      const row = within(card);
      expect(row.getAllByRole("link")).toHaveLength(1);
      expect(row.queryByRole("button")).toBeNull();
      expect(row.queryByRole("checkbox")).toBeNull();
      expect(row.queryByRole("combobox")).toBeNull();
      expect(
        card.querySelector("img, input, select, [draggable=true]"),
      ).toBeNull();
    }
    expect(
      view.queryByText(
        /unread|mark as read|assignee|labels|comments|questions|blocked|spec review/i,
      ),
    ).toBeNull();
    expect(
      view.queryByText(
        /annual|yearly|contributions|history|coverage|completeness/i,
      ),
    ).toBeNull();
    fireEvent.mouseEnter(view.getByRole("link", { name: alpha.title }));
    fireEvent.focus(view.getByRole("link", { name: alpha.title }));
    expect(fetch).not.toHaveBeenCalled();
    // The shared row reads two list-wide things — the viewer's ref placement
    // and each project's ref config — and nothing per card. Anything else in
    // the cache would mean a row started fetching on its own behalf.
    expect(
      view.client
        .getQueryCache()
        .getAll()
        .map((query) => JSON.stringify(query.queryKey))
        .sort(),
    ).toEqual(
      [
        '["me-prefs"]',
        '["reference-config","alpha-engine"]',
        '["reference-config","beta-tools"]',
      ].sort(),
    );
  });

  it("uses each card's current project identity, prefix and status", async () => {
    const view = mount();
    await view.findByRole("link", { name: alpha.title });
    const [first, second] = view.getAllByRole("listitem");
    expect(within(first).getByText("Alpha Engine")).not.toBeNull();
    expect(within(first).getByText("AX-42")).not.toBeNull();
    expect(within(first).queryByText("Beta Tools")).toBeNull();
    expect(within(first).queryByText("#42")).toBeNull();
    expect(within(second).getByText("Beta Tools")).not.toBeNull();
    expect(within(second).getByText("#42")).not.toBeNull();
    expect(within(second).queryByText("AX-42")).toBeNull();
    const review = within(first).getByText("In review");
    const done = within(second).getByText("Done");
    expect(
      review.querySelector<HTMLElement>("[aria-hidden]")?.style.backgroundColor,
    ).toBe("#8844cc");
    expect(
      done.querySelector<HTMLElement>("[aria-hidden]")?.style.backgroundColor,
    ).toBe("#228844");
    expect(within(first).queryByText("Done")).toBeNull();
    expect(within(second).queryByText("In review")).toBeNull();

    const moved: ActivityCard = {
      ...alpha,
      number: 9,
      project: { ...beta.project, id: alpha.project.id },
      status: beta.status,
      url: "/projects/beta-tools/issues/9",
    };
    view.update({ selection: { ...selection, items: [moved, beta] } });
    expect(view.getAllByRole("listitem")[0]).toBe(first);
    expect(within(first).getByRole("link").getAttribute("href")).toBe(
      "/projects/beta-tools/issues/9",
    );
    expect(within(first).getByText("Beta Tools")).not.toBeNull();
    // beta-tools has no prefix of its own, so the moved card wears `#`.
    expect(within(first).getByText("#9")).not.toBeNull();
    expect(within(first).getByText("Done")).not.toBeNull();
    expect(within(first).queryByText("Alpha Engine")).toBeNull();
    expect(within(first).queryByText("AX-42")).toBeNull();
    expect(within(first).queryByText("In review")).toBeNull();
  });

  it("preserves issue DOM identity across reordering and appends, even for equal issue numbers", async () => {
    const view = mount();
    const first = await view.findByRole("link", { name: alpha.title });
    const second = view.getByRole("link", { name: beta.title });
    view.update({
      selection: { ...selection, items: [beta, alpha, nextCard] },
    });
    const links = view.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toBe(second);
    expect(links[1]).toBe(first);
    expect(links[2].textContent).toBe("Document the queue");
    expect(view.getByText("17 active cards")).not.toBeNull();
    expect(view.queryByText("3 active cards")).toBeNull();
  });
});

describe("ActivityCardList native navigation", () => {
  it("exposes canonical native hrefs using project slug and issue number", async () => {
    const view = mount();
    const first = await view.findByRole("link", { name: alpha.title });
    const second = view.getByRole("link", { name: beta.title });
    expect(first.tagName).toBe("A");
    expect(first.getAttribute("href")).toBe("/projects/alpha-engine/issues/42");
    expect(second.getAttribute("href")).toBe("/projects/beta-tools/issues/42");
    expect(first.getAttribute("href")).not.toBe("/projects/61/issues/907");
    expect(first.getAttribute("href")).not.toBe(second.getAttribute("href"));
    expect(first.getAttribute("target")).toBeNull();
    expect(first.getAttribute("download")).toBeNull();
  });

  it.each([
    ["Repair the scheduler", "/projects/alpha-engine/issues/42"],
    ["Publish the package", "/projects/beta-tools/issues/42"],
  ])("navigates on ordinary activation of %s", async (title, path) => {
    const view = mount();
    const link = await view.findByRole("link", { name: title });
    expect(view.router.state.location.pathname).toBe("/");
    fireEvent.click(link);
    await waitFor(() => expect(view.router.state.location.pathname).toBe(path));
    expect(view.router.state.location.pathname).not.toBe("/");
  });

  it.each([
    ["Control", "click", { ctrlKey: true }],
    ["Command", "click", { metaKey: true }],
    ["Shift", "click", { shiftKey: true }],
    ["Alt", "click", { altKey: true }],
    ["middle click", "click", { button: 1 }],
    ["auxiliary click", "auxclick", { button: 1 }],
  ] as const)(
    "leaves %s activation to the browser",
    async (_name, type, init) => {
      const view = mount();
      const link = await view.findByRole("link", { name: beta.title });
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      fireEvent(link, event);
      expect(event.defaultPrevented).toBe(false);
      expect(view.router.state.location.pathname).toBe("/");
      expect(link.getAttribute("href")).toBe("/projects/beta-tools/issues/42");
      expect(view.getAllByRole("listitem")).toHaveLength(2);
    },
  );
});

describe("ActivityCardList timestamps", () => {
  it.each([
    ["America/Los_Angeles", "2026-07-02T00:30:00Z", "2026-07-01T17:30:00Z"],
    ["America/Los_Angeles", "2026-01-02T00:30:00Z", "2026-01-01T16:30:00Z"],
    ["Asia/Tokyo", "2026-07-02T00:30:00Z", "2026-07-02T09:30:00Z"],
  ])(
    "displays %s local time for %s and preserves the machine timestamp",
    async (timezone, instant, local) => {
      const view = mount({
        timezone,
        selection: {
          ...selection,
          items: [{ ...alpha, last_active_at: instant }],
        },
      });
      await view.findByRole("link", { name: alpha.title });
      const times = view.container.querySelectorAll("time");
      expect(times).toHaveLength(1);
      expect(times[0].getAttribute("datetime")).toBe(instant);
      expect(times[0].textContent).toBe(wallTime(local));
      expect(times[0].textContent).not.toBe(wallTime(instant));
      expect(times[0].textContent).not.toBe("2026-07-02");
    },
  );

  it("updates the timezone display without changing the stored timestamp or card identity", async () => {
    const view = mount();
    const link = await view.findByRole("link", { name: alpha.title });
    const time = view.getAllByRole("listitem")[0].querySelector("time");
    expect(time?.textContent).toBe(wallTime("2026-07-02T00:30:00Z"));
    view.update({ timezone: "America/Los_Angeles" });
    expect(view.getByRole("link", { name: alpha.title })).toBe(link);
    expect(time?.textContent).toBe(wallTime("2026-07-01T17:30:00Z"));
    expect(time?.textContent).not.toBe(wallTime("2026-07-02T00:30:00Z"));
    expect(time?.getAttribute("datetime")).toBe("2026-07-02T00:30:00Z");
  });
});

describe("ActivityCardList selection and request states", () => {
  it("distinguishes no selection from a recorded empty day", async () => {
    const view = mount({ selection: null });
    await view.findByText("Select a day.");
    expect(view.queryByRole("heading")).toBeNull();
    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByText("0 active cards")).toBeNull();
    expect(view.queryByText("No active cards on 2026-07-02.")).toBeNull();
    view.update({
      selection: {
        ...selection,
        total: 0,
        items: [],
        has_more: false,
        next_cursor: null,
      },
    });
    expect(view.getByText("No active cards on 2026-07-02.")).not.toBeNull();
    expect(view.getByText("0 active cards")).not.toBeNull();
    expect(view.queryByText("Select a day.")).toBeNull();
    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
  });

  it("uses the server total for singular wording", async () => {
    const view = mount({
      selection: {
        ...selection,
        total: 1,
        items: [alpha],
        has_more: false,
        next_cursor: null,
      },
    });
    await view.findByText("1 active card");
    expect(view.queryByText("1 active cards")).toBeNull();
    expect(view.getAllByRole("link")).toHaveLength(1);
  });

  it("shows initial loading without an empty state or an actionable retry", async () => {
    const onRetry = vi.fn();
    const view = mount({ selection: null, loading: true, onRetry });
    expect((await view.findByRole("status")).textContent).toBe(
      "Loading activity…",
    );
    expect(view.getByRole("region").getAttribute("aria-busy")).toBe("true");
    expect(view.queryByText("Select a day.")).toBeNull();
    expect(view.queryByText("No active cards on 2026-07-02.")).toBeNull();
    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("shows initial failure and calls only the retry callback", async () => {
    const onRetry = vi.fn();
    const onLoadMore = vi.fn();
    const view = mount({
      selection: null,
      error: "Request failed",
      onRetry,
      onLoadMore,
    });
    expect((await view.findByRole("alert")).textContent).toContain(
      "Request failed",
    );
    expect(view.queryByRole("list")).toBeNull();
    expect(view.queryByRole("status")).toBeNull();
    expect(view.queryByText("Select a day.")).toBeNull();
    expect(view.queryByText("No active cards on 2026-07-02.")).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(onRetry.mock.calls).toEqual([[]]);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it.each(["loading", "loadingMore"] as const)(
    "disables Retry during %s and hides Load more while an error is present",
    async (pending) => {
      const onRetry = vi.fn();
      const onLoadMore = vi.fn();
      const view = mount({
        error: "Request failed",
        [pending]: true,
        onRetry,
        onLoadMore,
      });
      const retry = (await view.findByRole("button", {
        name: "Retry",
      })) as HTMLButtonElement;
      expect(retry.disabled).toBe(true);
      expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
      expect(view.getAllByRole("listitem")).toHaveLength(2);
      expect(view.getByRole("region").getAttribute("aria-busy")).toBe("true");
      fireEvent.click(retry);
      expect(onRetry).not.toHaveBeenCalled();
      expect(onLoadMore).not.toHaveBeenCalled();
    },
  );

  it("keeps existing cards and totals through refresh loading and failure", async () => {
    const view = mount();
    const link = await view.findByRole("link", { name: alpha.title });
    view.update({ loading: true });
    expect(view.getByRole("link", { name: alpha.title })).toBe(link);
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    expect(view.getByText("17 active cards")).not.toBeNull();
    // The shared footer reports progress in its label, not by disabling.
    expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(view.getByRole("button", { name: "Loading…" })).not.toBeNull();
    view.update({ error: "Refresh failed" });
    expect(view.getByRole("alert").textContent).toContain("Refresh failed");
    expect(view.getByRole("link", { name: alpha.title })).toBe(link);
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    expect(view.getByText("17 active cards")).not.toBeNull();
    expect(view.queryByRole("status")).toBeNull();
    expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("constrains long project names, references and titles to the available width", async () => {
    const title = "LongTitle".repeat(30);
    const name = "LongProject".repeat(30);
    const prefix = "LONG".repeat(30);
    const view = mount(
      {
        selection: {
          ...selection,
          items: [{ ...alpha, title, project: { ...alpha.project, name } }],
        },
      },
      { "alpha-engine": prefix },
    );
    const link = await view.findByRole("link", { name: title });
    const region = view.getByRole("region");
    expect(region.className).toContain("min-w-0");
    expect(region.className).toContain("max-w-full");
    // happy-dom has no layout engine; assert the CSS constraints themselves.
    // The shared row defends the width with a floorless flexible track plus
    // per-cell truncation, not with break-words on every cell.
    expect(view.getByRole("list").className).toContain("minmax(0,1fr)");
    for (const element of [link, view.getByText(name)]) {
      expect(element.className).toContain("min-w-0");
      expect(element.className).toContain("truncate");
    }
    // The ref keeps its own width instead of wrapping; the title gives way.
    expect(view.getByText(`${prefix}-42`).className).toContain(
      "whitespace-nowrap",
    );
  });
});

describe("ActivityCardList pagination", () => {
  it("loads more, retains cards through append loading/error, delegates retry, and appends in order", async () => {
    const onLoadMore = vi.fn();
    const onRetry = vi.fn();
    const view = mount({ onLoadMore, onRetry });
    const first = await view.findByRole("link", { name: alpha.title });
    const second = view.getByRole("link", { name: beta.title });
    expect(onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Load more" }));
    expect(onLoadMore.mock.calls).toEqual([[]]);

    view.update({ loadingMore: true });
    expect(view.getByRole("status").textContent).toBe("Loading more activity…");
    expect(view.getByRole("region").getAttribute("aria-busy")).toBe("true");
    expect(view.getAllByRole("link")).toEqual([first, second]);
    expect(view.getByText("17 active cards")).not.toBeNull();
    const pending = view.getByRole("button", { name: "Loading…" });
    // Clickable, but a second request is refused while one is in flight.
    fireEvent.click(pending);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.update({ error: "Page unavailable" });
    expect(view.getByRole("alert").textContent).toContain(
      "Could not load activity: Page unavailable",
    );
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByRole("region").getAttribute("aria-busy")).toBe("false");
    expect(view.getAllByRole("link")).toEqual([first, second]);
    expect(view.getByText("17 active cards")).not.toBeNull();
    expect(view.queryByText("No active cards on 2026-07-02.")).toBeNull();
    expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
    const retry = view.getByRole("button", {
      name: "Retry",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(onRetry.mock.calls).toEqual([[]]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.update({ loadingMore: true, error: "Page unavailable" });
    expect(
      (view.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(view.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(view.getAllByRole("link")).toEqual([first, second]);
    view.update({
      selection: {
        ...selection,
        items: [alpha, beta, nextCard],
        has_more: false,
        next_cursor: null,
      },
    });
    const links = view.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toBe(first);
    expect(links[1]).toBe(second);
    expect(links[2].getAttribute("href")).toBe(
      "/projects/alpha-engine/issues/7",
    );
    expect(view.getByText("17 active cards")).not.toBeNull();
    expect(view.queryByText("3 active cards")).toBeNull();
    expect(view.queryByRole("button")).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByRole("status")).toBeNull();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("offers no pagination when the server says the selection is complete", async () => {
    const onLoadMore = vi.fn();
    const view = mount({
      selection: { ...selection, has_more: false, next_cursor: null },
      onLoadMore,
    });
    await view.findByRole("link", { name: alpha.title });
    expect(view.getAllByRole("listitem")).toHaveLength(2);
    expect(view.queryByRole("button")).toBeNull();
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});
it("announces a refresh without taking a line from the cards", async () => {
  const selection = {
    date: "2026-07-02",
    total: 1,
    items: [alpha],
    has_more: false,
    next_cursor: null,
  };
  const view = renderWithProviders(
    <ActivityCardList
      selection={selection}
      timezone="UTC"
      loading
      onLoadMore={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  await view.findByRole("link", { name: alpha.title });
  // The progress report belongs to the screen reader; a visible line would
  // push the row the reader is pointing at down the page on every refresh.
  expect(view.getByRole("status").className).toContain("sr-only");
});
