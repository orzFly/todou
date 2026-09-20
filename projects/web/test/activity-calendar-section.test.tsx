import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ActivityCalendarResponse,
  ActivityCard,
  ActivityDay,
} from "@todou/shared";
import { TodouError } from "@todou/shared";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectActivityCalendarQuery,
  userActivityCalendarQuery,
} from "../src/api/activity-calendar.ts";
import { api } from "../src/api/queries.ts";
import { ActivityCalendar } from "../src/components/activity-calendar/activity-calendar.tsx";
import {
  ActivityCalendarSection,
  type ActivityCalendarSectionProps,
} from "../src/components/activity-calendar/activity-calendar-section.tsx";
import { ActivityCardList } from "../src/components/activity-calendar/activity-card-list.tsx";

// Keep assertions at the wrapper boundary; the real query API and shared
// transport entry points run under QueryClient. Leaves have their own UI tests.
vi.mock("../src/components/activity-calendar/activity-calendar.tsx", () => ({
  ActivityCalendar: vi.fn(),
}));
vi.mock("../src/components/activity-calendar/activity-card-list.tsx", () => ({
  ActivityCardList: vi.fn(),
}));

const calendar = vi.mocked(ActivityCalendar);
const list = vi.mocked(ActivityCardList);
const clients: QueryClient[] = [];
const scopes: ActivityCalendarSectionProps["scope"][] = [
  { kind: "project", projectId: 1, slug: "demo" },
  { kind: "user", subjectId: 7 },
];
const day = "2026-03-01";
const nextDay = "2026-03-02";
const recorded: ActivityDay[] = [
  { date: day, state: "recorded", count: 2 },
  { date: nextDay, state: "recorded", count: 0 },
];

function card(id: number): ActivityCard {
  return {
    project: { id: 1, slug: "demo", name: "Demo", issue_prefix: null },
    issue_id: id,
    number: id,
    title: `Card ${id}`,
    status: {
      id: 1,
      name: "Open",
      category: "open",
      color: "#123456",
      position: 0,
      is_default: true,
    },
    url: `/projects/demo/issues/${id}`,
    last_active_at: "2026-03-01T12:00:00Z",
  };
}

function snapshot(
  selectedDay?: string,
  ids = [1],
  cursor: string | null = "next",
): ActivityCalendarResponse {
  return {
    from: "2026-01-01",
    to: "2027-01-01",
    timezone: "UTC",
    cutoff: "2026-03-02T01:00:00Z",
    read_started_at: "2026-03-02T01:00:00Z",
    read_finished_at: "2026-03-02T01:00:00Z",
    days: recorded,
    selection: selectedDay
      ? {
          date: selectedDay,
          total: 2,
          items: ids.map(card),
          next_cursor: cursor,
          has_more: cursor !== null,
        }
      : null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function props(
  overrides: Partial<ActivityCalendarSectionProps> = {},
): ActivityCalendarSectionProps {
  return {
    viewerId: 42,
    scope: scopes[0]!,
    from: "2026-01-01",
    to: "2027-01-01",
    day,
    timezone: "UTC",
    today: "2026-02-28",
    limit: 1,
    onDayChange: vi.fn(),
    ...overrides,
  };
}

function mount(initialProps = props(), strict = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  const tree = (value: ActivityCalendarSectionProps) => (
    <QueryClientProvider client={client}>
      {strict ? (
        <StrictMode>
          <ActivityCalendarSection {...value} />
        </StrictMode>
      ) : (
        <ActivityCalendarSection {...value} />
      )}
    </QueryClientProvider>
  );
  const view = render(tree(initialProps));
  return {
    ...view,
    client,
    rerender: (value: ActivityCalendarSectionProps) =>
      view.rerender(tree(value)),
  };
}

function activeOptions(
  value: ActivityCalendarSectionProps,
  selectedDay = value.day,
) {
  const request = {
    viewerId: value.viewerId,
    from: value.from,
    to: value.to,
    day: selectedDay,
    tz: value.timezone,
    limit: value.limit,
  };
  return value.scope.kind === "project"
    ? projectActivityCalendarQuery({
        ...request,
        projectId: value.scope.projectId,
        slug: value.scope.slug,
      })
    : userActivityCalendarQuery({
        ...request,
        subjectId: value.scope.subjectId,
      });
}

function mockTransport() {
  const project = vi
    .spyOn(api, "getProjectActivityCalendar")
    .mockImplementation(async (_slug, input) => snapshot(input.day));
  const user = vi
    .spyOn(api, "getUserActivityCalendar")
    .mockImplementation(async (_subject, input) => snapshot(input.day));
  return { project, user };
}

beforeEach(() => {
  calendar.mockImplementation((value) => (
    <section aria-label="Calendar">
      <span>{value.today}</span>
      {value.loading && <span>Calendar loading</span>}
      {value.error && (
        <div role="alert">
          {value.error}
          <button type="button" onClick={value.onRetry}>
            Calendar retry
          </button>
        </div>
      )}
      <button type="button" onClick={() => value.onDayChange(nextDay)}>
        Choose day
      </button>
    </section>
  ));
  list.mockImplementation((value) => (
    <section aria-label="Cards">
      {value.selection?.items.map((item) => (
        <span key={item.issue_id}>{item.title}</span>
      ))}
      {value.error && (
        <div role="alert">
          {value.error}
          <button type="button" onClick={value.onRetry}>
            Page retry
          </button>
        </div>
      )}
      {value.selection?.has_more && (
        <button
          type="button"
          disabled={value.loading || value.loadingMore}
          onClick={value.onLoadMore}
        >
          Load more
        </button>
      )}
    </section>
  ));
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("ActivityCalendarSection", () => {
  it.each(scopes)(
    "validates the requested day and shares one snapshot for $kind",
    async (scope) => {
      const transport = mockTransport();
      const value = props({ scope, timezone: "Pacific/Honolulu" });
      const view = mount(value);
      expect(calendar.mock.lastCall?.[0].today).toBe(value.today);
      await screen.findByText("Card 1");
      const endpoint =
        scope.kind === "project" ? transport.project : transport.user;
      const identity = scope.kind === "project" ? scope.slug : scope.subjectId;
      expect(endpoint.mock.calls).toEqual([
        [
          identity,
          {
            from: "2026-01-01",
            to: "2027-01-01",
            day: undefined,
            tz: value.timezone,
            limit: 1,
            after: undefined,
          },
        ],
        [
          identity,
          {
            from: "2026-01-01",
            to: "2027-01-01",
            day,
            tz: value.timezone,
            limit: 1,
            after: undefined,
          },
        ],
      ]);
      expect(
        scope.kind === "project" ? transport.user : transport.project,
      ).not.toHaveBeenCalled();
      const response = view.client.getQueryData(activeOptions(value).queryKey);
      expect(calendar.mock.lastCall?.[0].days).toBe(response?.days);
      expect(calendar.mock.lastCall?.[0].selection).toBe(response?.selection);
      expect(list.mock.lastCall?.[0].selection).toBe(response?.selection);
      expect(list.mock.lastCall?.[0].timezone).toBe("UTC");
      expect(calendar.mock.lastCall?.[0].today).toBe(nextDay);
      expect(value.onDayChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("Choose day"));
      expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(nextDay);
      expect(value.onDayChange).not.toHaveBeenCalledWith(
        nextDay,
        expect.anything(),
      );
    },
  );

  it.each([
    { label: "current", days: recorded, expected: nextDay },
    {
      label: "historical",
      days: [{ date: "2025-12-30", state: "recorded", count: 0 }],
      expected: "2025-12-30",
    },
    {
      label: "all disabled",
      days: [{ date: day, state: "not_applicable", count: null }],
      expected: undefined,
    },
    { label: "empty", days: [], expected: undefined },
  ] satisfies {
    label: string;
    days: ActivityDay[];
    expected: string | undefined;
  }[])(
    "defaults once for $label no-day responses",
    async ({ days, expected }) => {
      const result = { ...snapshot(), days };
      const transport = vi
        .spyOn(api, "getProjectActivityCalendar")
        .mockResolvedValue(result);
      const value = props({ day: undefined });
      const view = mount(value, true);
      await waitFor(() =>
        expect(calendar.mock.lastCall?.[0].loading).toBe(false),
      );
      if (expected)
        expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(expected, {
          replace: true,
        });
      else expect(value.onDayChange).not.toHaveBeenCalled();
      const replacement = vi.fn();
      view.rerender({ ...value, onDayChange: replacement });
      expect(replacement).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Cards")).toBeNull();
      expect(
        transport.mock.calls.every((call) => call[1].day === undefined),
      ).toBe(true);
    },
  );

  it("uses response cutoff/timezone to prefer recorded today over the last recorded bucket", async () => {
    vi.spyOn(api, "getProjectActivityCalendar").mockResolvedValue({
      ...snapshot(),
      timezone: "America/Los_Angeles",
    });
    const value = props({ day: undefined, timezone: "Asia/Tokyo" });
    mount(value);
    await waitFor(() =>
      expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(day, {
        replace: true,
      }),
    );
    expect(calendar.mock.lastCall?.[0].today).toBe(day);
  });

  it("clears an invalid explicit day once when every bucket is disabled", async () => {
    vi.spyOn(api, "getProjectActivityCalendar").mockResolvedValue({
      ...snapshot(),
      days: [{ date: day, state: "not_applicable", count: null }],
    });
    const onReady = vi.fn();
    const value = props({ onInvalidDay: vi.fn(), onReady });
    const view = mount(value);
    await waitFor(() =>
      expect(value.onInvalidDay).toHaveBeenCalledExactlyOnceWith(undefined),
    );
    expect(value.onDayChange).not.toHaveBeenCalled();
    const replacement = vi.fn();
    view.rerender({ ...value, onInvalidDay: replacement });
    expect(replacement).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Cards")).toBeNull();
    expect(onReady).not.toHaveBeenCalledWith(true);
    view.rerender({ ...value, day: undefined });
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
    expect(value.onInvalidDay).toHaveBeenCalledTimes(1);
    expect(value.onDayChange).not.toHaveBeenCalled();
  });

  it.each(["not_applicable", "future"] as const)(
    "never queries a requested %s day",
    async (state) => {
      const transport = vi
        .spyOn(api, "getProjectActivityCalendar")
        .mockResolvedValue({
          ...snapshot(),
          days: [{ date: day, state, count: null }, recorded[1]!],
        });
      const value = props({ onInvalidDay: vi.fn() });
      mount(value);
      await waitFor(() =>
        expect(value.onInvalidDay).toHaveBeenCalledExactlyOnceWith(nextDay),
      );
      expect(value.onDayChange).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]?.[1].day).toBeUndefined();
      expect(calendar.mock.lastCall?.[0].selection).toBeNull();
    },
  );

  it.each([true, false])(
    "retains invalid-day fallback without a rejection callback, recorded=%s",
    async (hasRecorded) => {
      vi.spyOn(api, "getProjectActivityCalendar").mockResolvedValue({
        ...snapshot(),
        days: hasRecorded ? [recorded[1]!] : [],
      });
      const onReady = vi.fn();
      const value = props({ onReady });
      mount(value);
      await waitFor(() =>
        expect(calendar.mock.lastCall?.[0].loading).toBe(false),
      );
      if (hasRecorded) {
        expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(nextDay, {
          replace: true,
        });
      } else {
        expect(value.onDayChange).not.toHaveBeenCalled();
        expect(onReady).toHaveBeenLastCalledWith(true);
      }
    },
  );

  const identityChanges: Partial<ActivityCalendarSectionProps>[] = [
    { viewerId: 43 },
    { scope: { kind: "project", projectId: 2, slug: "demo" } },
    { scope: { kind: "project", projectId: 1, slug: "other" } },
    { scope: { kind: "user", subjectId: 7 } },
    { from: "2025-01-01", to: "2026-01-01", day: "2025-03-01" },
    { day: nextDay },
    { timezone: "Asia/Tokyo" },
    { limit: 2 },
  ];
  it.each(identityChanges)(
    "clears old rows immediately for changed request %j",
    async (change) => {
      const transport = mockTransport();
      const value = props();
      const view = mount(value);
      await screen.findByText("Card 1");
      const pending = deferred<ActivityCalendarResponse>();
      transport.project.mockReturnValue(pending.promise);
      transport.user.mockReturnValue(pending.promise);
      view.rerender({ ...value, ...change });
      expect(screen.queryByText("Card 1")).toBeNull();
      expect(calendar.mock.lastCall?.[0].selection).toBeNull();
    },
  );

  it.each([
    { viewerId: 43 },
    { scope: { kind: "user" as const, subjectId: 8 } },
  ])("clears personal rows on identity change %j", async (change) => {
    const transport = mockTransport();
    const value = props({ scope: scopes[1]! });
    const view = mount(value);
    await screen.findByText("Card 1");
    transport.user.mockReturnValue(
      deferred<ActivityCalendarResponse>().promise,
    );
    view.rerender({ ...value, ...change });
    expect(screen.queryByText("Card 1")).toBeNull();
  });

  it.each(scopes)(
    "loads a page, retains rows on error and retries the same $kind cursor",
    async (scope) => {
      const transport = mockTransport();
      const endpoint =
        scope.kind === "project" ? transport.project : transport.user;
      const value = props({ scope });
      mount(value);
      await screen.findByText("Card 1");
      endpoint.mockRejectedValueOnce(new Error("Page unavailable"));
      fireEvent.click(screen.getByText("Load more"));
      await screen.findByText("Page unavailable");
      expect(screen.getByText("Card 1")).toBeTruthy();
      expect(calendar.mock.lastCall?.[0].error).toBeNull();
      endpoint.mockResolvedValueOnce(snapshot(day, [2], null));
      fireEvent.click(screen.getByText("Page retry"));
      await screen.findByText("Card 2");
      expect(screen.getByText("Card 1")).toBeTruthy();
      expect(screen.queryByText("Page unavailable")).toBeNull();
      expect(endpoint.mock.calls.slice(-2).map((call) => call[1])).toEqual([
        {
          from: "2026-01-01",
          to: "2027-01-01",
          day,
          tz: "UTC",
          limit: 1,
          after: "next",
        },
        {
          from: "2026-01-01",
          to: "2027-01-01",
          day,
          tz: "UTC",
          limit: 1,
          after: "next",
        },
      ]);
      expect(calendar.mock.lastCall?.[0].selection).toBe(
        list.mock.lastCall?.[0].selection,
      );
    },
  );

  it("guards duplicate continuations synchronously and aborts on unmount", async () => {
    const transport = mockTransport();
    const view = mount();
    await screen.findByText("Card 1");
    const pending = deferred<ActivityCalendarResponse>();
    transport.project.mockReturnValueOnce(pending.promise);
    const abort = vi.spyOn(AbortController.prototype, "abort");
    const load = list.mock.lastCall?.[0].onLoadMore;
    act(() => {
      load?.();
      load?.();
    });
    await waitFor(() => expect(transport.project).toHaveBeenCalledTimes(3));
    expect(list.mock.lastCall?.[0].loadingMore).toBe(true);
    const before = abort.mock.calls.length;
    view.unmount();
    expect(abort.mock.calls.length).toBeGreaterThan(before);
    await act(async () => {
      pending.resolve(snapshot(day, [99], null));
      await pending.promise;
    });
    expect(
      view.client
        .getQueryData(activeOptions(props()).queryKey)
        ?.selection?.items.map((item) => item.issue_id),
    ).toEqual([1]);
  });

  it("aborts continuation on key change and rejects a late old display", async () => {
    const transport = mockTransport();
    const value = props();
    const view = mount(value);
    await screen.findByText("Card 1");
    const pending = deferred<ActivityCalendarResponse>();
    transport.project.mockReturnValueOnce(pending.promise);
    const abort = vi.spyOn(AbortController.prototype, "abort");
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(transport.project).toHaveBeenCalledTimes(3));
    const before = abort.mock.calls.length;
    transport.project.mockImplementation(async (_slug, input) =>
      snapshot(input.day, [2], null),
    );
    view.rerender({ ...value, day: nextDay });
    expect(abort.mock.calls.length).toBeGreaterThan(before);
    await screen.findByText("Card 2");
    await act(async () => {
      pending.resolve(snapshot(day, [99], null));
      await pending.promise;
    });
    expect(screen.queryByText("Card 99")).toBeNull();
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(list.mock.lastCall?.[0].error).toBeNull();
  });

  it("disables continuation during base fetching and clears an old page error on an equal fresh snapshot", async () => {
    const transport = mockTransport();
    const value = props();
    const view = mount(value);
    await screen.findByText("Card 1");
    transport.project.mockRejectedValueOnce(new Error("Old page error"));
    fireEvent.click(screen.getByText("Load more"));
    await screen.findByText("Old page error");
    const pending = deferred<ActivityCalendarResponse>();
    transport.project.mockReturnValueOnce(pending.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.client.refetchQueries({
        queryKey: activeOptions(value).queryKey,
        exact: true,
      });
    });
    await waitFor(() => expect(list.mock.lastCall?.[0].loading).toBe(true));
    const count = transport.project.mock.calls.length;
    act(() => {
      list.mock.lastCall?.[0].onLoadMore();
    });
    expect(transport.project).toHaveBeenCalledTimes(count);
    expect(list.mock.lastCall?.[0].loadingMore).toBe(false);
    await act(async () => {
      pending.resolve(snapshot(day));
      await refresh;
    });
    await waitFor(() =>
      expect(screen.queryByText("Old page error")).toBeNull(),
    );
    expect(screen.getByText("Card 1")).toBeTruthy();
  });

  it("does not leak a pending continuation rejection after successful base replacement", async () => {
    const transport = mockTransport();
    const value = props();
    const view = mount(value);
    await screen.findByText("Card 1");
    const pending = deferred<ActivityCalendarResponse>();
    transport.project.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(transport.project).toHaveBeenCalledTimes(3));
    transport.project.mockResolvedValueOnce(snapshot(day, [3], null));
    await act(async () => {
      await view.client.refetchQueries({
        queryKey: activeOptions(value).queryKey,
        exact: true,
      });
    });
    await screen.findByText("Card 3");
    await act(async () => {
      pending.reject(new Error("Stale failure"));
      await pending.promise.catch(() => undefined);
    });
    expect(screen.queryByText("Stale failure")).toBeNull();
    expect(list.mock.lastCall?.[0].error).toBeNull();
    expect(screen.queryByText("Card 1")).toBeNull();
  });

  it("does not resurrect bootstrap counts while a conflicted selected snapshot is replaced", async () => {
    const transport = mockTransport();
    const view = mount();
    await screen.findByText("Card 1");
    const replacement = deferred<ActivityCalendarResponse>();
    transport.project.mockRejectedValueOnce(
      new TodouError(409, "conflict", "Snapshot changed"),
    );
    transport.project.mockReturnValueOnce(replacement.promise);
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(transport.project).toHaveBeenCalledTimes(4));
    expect(
      view.client.getQueryState(activeOptions(props()).queryKey)
        ?.dataUpdateCount,
    ).toBe(2);
    await waitFor(() => expect(calendar.mock.lastCall?.[0].days).toEqual([]));
    expect(screen.queryByText("Card 1")).toBeNull();
    expect(
      view.client.getQueryState(activeOptions(props()).queryKey)?.fetchStatus,
    ).toBe("fetching");
    await act(async () => {
      replacement.resolve(snapshot(day, [3], null));
      await replacement.promise;
    });
    await screen.findByText("Card 3");
    expect(calendar.mock.lastCall?.[0].selection).toBe(
      list.mock.lastCall?.[0].selection,
    );
    expect(
      view.client.getQueryState(activeOptions(props()).queryKey)?.fetchStatus,
    ).toBe("idle");
    expect(transport.project).toHaveBeenCalledTimes(4);
  });

  it("withdraws a cached no-day snapshot safely during conflict recovery before choosing a fresh default", async () => {
    const transport = mockTransport();
    const onReady = vi.fn();
    const value = props({ day: undefined, onReady });
    const view = mount(value);
    await waitFor(() =>
      expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(nextDay, {
        replace: true,
      }),
    );
    expect(calendar.mock.lastCall?.[0].days).toEqual(recorded);
    const replacement = deferred<ActivityCalendarResponse>();
    transport.project.mockRejectedValueOnce(
      new TodouError(409, "conflict", "Snapshot changed"),
    );
    transport.project.mockReturnValueOnce(replacement.promise);
    let refresh!: Promise<void>;
    act(() => {
      refresh = view.client.refetchQueries({
        queryKey: activeOptions(value).queryKey,
        exact: true,
      });
    });
    await waitFor(() => expect(transport.project).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(calendar.mock.lastCall?.[0].days).toEqual([]));
    expect(calendar.mock.lastCall?.[0].selection).toBeNull();
    expect(calendar.mock.lastCall?.[0].loading).toBe(true);
    expect(onReady).not.toHaveBeenCalledWith(true);
    expect(value.onDayChange).toHaveBeenCalledTimes(1);
    expect(
      view.client.getQueryState(activeOptions(value).queryKey)?.data,
    ).toBeUndefined();
    await act(async () => {
      replacement.resolve({ ...snapshot(), days: [recorded[0]!] });
      await refresh;
    });
    await waitFor(() =>
      expect(value.onDayChange).toHaveBeenLastCalledWith(day, {
        replace: true,
      }),
    );
    expect(value.onDayChange).toHaveBeenCalledTimes(2);
    expect(calendar.mock.lastCall?.[0].days).toEqual([recorded[0]!]);
    expect(calendar.mock.lastCall?.[0].loading).toBe(false);
  });

  it.each([new Error(""), { private: "must not stringify" }, "opaque failure"])(
    "shows generic initial failure safely and retries: %j",
    async (failure) => {
      const transport = vi
        .spyOn(api, "getProjectActivityCalendar")
        .mockRejectedValueOnce(failure);
      const value = props({ day: undefined });
      mount(value);
      await screen.findByText("Please try again.");
      expect(value.onDayChange).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Cards")).toBeNull();
      expect(calendar.mock.lastCall?.[0].days).toEqual([]);
      transport.mockResolvedValueOnce(snapshot());
      fireEvent.click(screen.getByText("Calendar retry"));
      await waitFor(() =>
        expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(nextDay, {
          replace: true,
        }),
      );
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps selected rows on refresh error and retries the selected base request", async () => {
    const transport = mockTransport();
    const value = props();
    const view = mount(value);
    await screen.findByText("Card 1");
    transport.project.mockRejectedValueOnce(new Error("Refresh failed"));
    await act(async () => {
      await view.client.refetchQueries({
        queryKey: activeOptions(value).queryKey,
        exact: true,
      });
    });
    await screen.findByText("Refresh failed");
    expect(screen.getByText("Card 1")).toBeTruthy();
    transport.project.mockResolvedValueOnce(snapshot(day, [3], null));
    const calls = transport.project.mock.calls.length;
    act(() => {
      list.mock.lastCall?.[0].onLoadMore();
    });
    expect(transport.project).toHaveBeenCalledTimes(calls);
    expect(calendar.mock.lastCall?.[0].error).toBeNull();
    fireEvent.click(screen.getByText("Page retry"));
    await screen.findByText("Card 3");
    expect(transport.project.mock.lastCall?.[1]).toEqual({
      from: "2026-01-01",
      to: "2027-01-01",
      day,
      tz: "UTC",
      limit: 1,
      after: undefined,
    });
  });

  it.each(["error", "empty"] as const)(
    "reports readiness after settled %s and withdraws it on cleanup",
    async (outcome) => {
      const pending = deferred<ActivityCalendarResponse>();
      vi.spyOn(api, "getProjectActivityCalendar").mockReturnValue(
        pending.promise,
      );
      const onReady = vi.fn();
      const view = mount(props({ day: undefined, onReady }));
      expect(onReady).toHaveBeenLastCalledWith(false);
      await act(async () => {
        if (outcome === "error") pending.reject(new Error("Unavailable"));
        else pending.resolve({ ...snapshot(), days: [] });
        await pending.promise.catch(() => undefined);
      });
      await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
      view.unmount();
      expect(onReady).toHaveBeenLastCalledWith(false);
    },
  );

  it("waits for the validated selected request before reporting readiness", async () => {
    const selected = deferred<ActivityCalendarResponse>();
    const transport = vi
      .spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(selected.promise);
    const onReady = vi.fn();
    const view = mount(props({ onReady }));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(onReady).not.toHaveBeenCalledWith(true);
    await act(async () => {
      selected.resolve(snapshot(day));
      await selected.promise;
    });
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
    view.unmount();
    expect(onReady).toHaveBeenLastCalledWith(false);
  });

  it("waits for the parent to apply an automatic default before reporting readiness", async () => {
    mockTransport();
    const onReady = vi.fn();
    const value = props({ day: undefined, onReady });
    const view = mount(value);
    await waitFor(() =>
      expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(nextDay, {
        replace: true,
      }),
    );
    expect(onReady).not.toHaveBeenCalledWith(true);
    view.rerender({ ...value, day: nextDay });
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
  });

  it("keeps the real calendar focused through Enter selection and does not refetch annual data", async () => {
    const actual = await vi.importActual<{
      ActivityCalendar: typeof ActivityCalendar;
    }>("../src/components/activity-calendar/activity-calendar.tsx");
    calendar.mockImplementation(actual.ActivityCalendar);
    const transport = mockTransport();
    const value = props({ day: nextDay });
    const view = mount(value);
    await screen.findByText("Card 1");
    const tile = view.container.querySelector<HTMLButtonElement>(
      `[data-date="${day}"]`,
    )!;
    act(() => {
      tile.focus();
    });
    fireEvent.keyDown(tile, { key: "Enter" });
    expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith(day);
    expect(value.onDayChange).not.toHaveBeenCalledWith(day, expect.anything());
    const pending = deferred<ActivityCalendarResponse>();
    transport.project.mockReturnValueOnce(pending.promise);
    view.rerender({ ...value, day });
    expect(document.activeElement).toBe(tile);
    expect(screen.queryByText("Card 1")).toBeNull();
    await act(async () => {
      pending.resolve(snapshot(day, [2], null));
      await pending.promise;
    });
    await screen.findByText("Card 2");
    expect(document.activeElement).toBe(tile);
    expect(
      transport.project.mock.calls.filter((call) => call[1].day === undefined),
    ).toHaveLength(1);
  });

  it("restores real calendar date focus after a controlled year response replaces the dates", async () => {
    const actual = await vi.importActual<{
      ActivityCalendar: typeof ActivityCalendar;
    }>("../src/components/activity-calendar/activity-calendar.tsx");
    calendar.mockImplementation(actual.ActivityCalendar);
    const transport = mockTransport();
    const value = props();
    const view = mount(value);
    await screen.findByText("Card 1");
    act(() => {
      view.container
        .querySelector<HTMLButtonElement>(`[data-date="${day}"]`)!
        .focus();
    });
    const pending = deferred<ActivityCalendarResponse>();
    transport.project.mockReturnValueOnce(pending.promise);
    view.rerender({
      ...value,
      from: "2025-01-01",
      to: "2026-01-01",
      day: undefined,
    });
    const historic = {
      ...snapshot(),
      from: "2025-01-01",
      to: "2026-01-01",
      days: [{ date: "2025-12-31", state: "recorded" as const, count: 0 }],
    };
    await act(async () => {
      pending.resolve(historic);
      await pending.promise;
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.container.querySelector('[data-date="2025-12-31"]'),
      ),
    );
    expect(value.onDayChange).toHaveBeenCalledExactlyOnceWith("2025-12-31", {
      replace: true,
    });
  });
});
