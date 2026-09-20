import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  type ActivityCalendarResponse,
  type ActivityCard,
  TodouError,
} from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadMoreProjectActivityCalendar,
  loadMoreUserActivityCalendar,
  type ProjectActivityCalendarRequest,
  projectActivityCalendarQuery,
  userActivityCalendarQuery,
} from "../src/api/activity-calendar.ts";
import { api } from "../src/api/queries.ts";

/**
 * The server states each cell's instants; fixtures spell out plain UTC ones so
 * a test's own dates stay readable. Only the DST cases below vary them.
 */
function dayBounds(date: string): { start: string; end: string } {
  // Cases that feed deliberately malformed dates still need a parseable pair:
  // the assertion under test is about `date`, not about these.
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed))
    return {
      start: "2024-01-01T00:00:00.000Z",
      end: "2024-01-02T00:00:00.000Z",
    };
  const next = new Date(parsed + 86_400_000).toISOString().slice(0, 10);
  return { start: `${date}T00:00:00.000Z`, end: `${next}T00:00:00.000Z` };
}

const input: ProjectActivityCalendarRequest = {
  viewerId: 42,
  projectId: 1,
  slug: "demo",
  from: "2026-01-01",
  to: "2027-01-01",
  day: "2026-03-01",
  tz: "UTC",
  limit: 1,
};
const personal = {
  viewerId: 42,
  subjectId: 7,
  from: "2026-01-01",
  to: "2027-01-01",
  day: input.day,
  tz: "UTC",
  limit: 1,
};
const at = "2026-03-02T12:00:00.000Z";

function card(issueId: number, projectId = 1): ActivityCard {
  return {
    project: {
      id: projectId,
      slug: `project-${projectId}`,
      name: "Demo",
      issue_prefix: null,
    },
    issue_id: issueId,
    number: issueId,
    title: `Card ${issueId}`,
    status: {
      id: 1,
      name: "Open",
      category: "open",
      color: "#123456",
      position: 0,
      is_default: true,
    },
    url: `/projects/project-${projectId}/issues/${issueId}`,
    last_active_at: "2026-03-01T12:00:00.123456Z",
  };
}

function response(
  items = [card(1)],
  cursor: string | null = "page-two",
  otherDayCount = 0,
): ActivityCalendarResponse {
  return {
    from: "2026-01-01",
    to: "2027-01-01",
    timezone: "UTC",
    cutoff: at,
    read_started_at: at,
    read_finished_at: at,
    days: Array.from({ length: 365 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1))
        .toISOString()
        .slice(0, 10);
      return date > "2026-03-02"
        ? { date, ...dayBounds(date), state: "future", count: null }
        : {
            date,
            ...dayBounds(date),
            state: "recorded",
            count:
              date === input.day
                ? 2
                : date === "2026-03-02"
                  ? otherDayCount
                  : 0,
          };
    }),
    selection: {
      date: "2026-03-01",
      total: 2,
      items,
      next_cursor: cursor,
      has_more: cursor !== null,
    },
  };
}

// The web package targets ES2023, before Promise.withResolvers.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const clients: QueryClient[] = [];
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(value);
  return value;
}

// Cancellation settles fetchQuery before a non-abortable transport finishes.
const settleTransport = () => vi.runAllTimersAsync();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const value of clients.splice(0)) value.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("activity query identity and cancellation", () => {
  it("snapshots explicit request fields and calls the typed canonical endpoints", async () => {
    const project = vi
      .spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValue(response());
    const user = vi
      .spyOn(api, "getUserActivityCalendar")
      .mockResolvedValue(response());
    const mutable = { ...input };
    const options = projectActivityCalendarQuery(mutable);
    mutable.tz = "Asia/Tokyo";
    mutable.viewerId = 99;
    await client().fetchQuery(options);
    expect(project).toHaveBeenCalledWith("demo", {
      from: "2026-01-01",
      to: "2027-01-01",
      day: input.day,
      tz: "UTC",
      limit: 1,
      after: undefined,
    });
    expect(options.queryKey).toEqual([
      "activity-project",
      "demo",
      {
        viewerId: 42,
        projectId: 1,
        from: "2026-01-01",
        to: "2027-01-01",
        day: input.day,
        tz: "UTC",
        limit: 1,
        after: undefined,
      },
    ]);
    await client().fetchQuery(userActivityCalendarQuery(personal));
    expect(user).toHaveBeenCalledWith(7, {
      from: "2026-01-01",
      to: "2027-01-01",
      day: input.day,
      tz: "UTC",
      limit: 1,
      after: undefined,
    });
  });

  it.each([
    { viewerId: 43 },
    { projectId: 2 },
    { slug: "other" },
    { from: "2025-01-01", to: "2026-01-01", day: "2025-03-01" },
    { day: "2026-03-02" },
    { day: undefined },
    { tz: "Asia/Tokyo" },
    { limit: 2 },
    { after: "cursor" },
  ])("separates every project identity/date/page field: %j", (change) => {
    const cache = client();
    const first = projectActivityCalendarQuery(input);
    cache.setQueryData(first.queryKey, response());
    const observer = new QueryObserver(cache, { ...first, enabled: false });
    expect(observer.getCurrentResult().data).toEqual(response());
    const next = projectActivityCalendarQuery({ ...input, ...change });
    observer.setOptions({ ...next, enabled: false });
    expect(observer.getCurrentResult().data).toBeUndefined();
    observer.destroy();
  });

  it("separates subjects and viewers while sharing numeric canonical identity", () => {
    const cache = client();
    cache.setQueryData(
      userActivityCalendarQuery(personal).queryKey,
      response(),
    );
    expect(
      cache.getQueryData(
        userActivityCalendarQuery({ ...personal, subjectId: 8 }).queryKey,
      ),
    ).toBeUndefined();
    expect(
      cache.getQueryData(
        userActivityCalendarQuery({ ...personal, viewerId: 43 }).queryKey,
      ),
    ).toBeUndefined();
  });

  it.each(["cancel", "logout"] as const)(
    "rejects a late first response after %s",
    async (operation) => {
      const cache = client();
      const pending = deferred<ActivityCalendarResponse>();
      vi.spyOn(api, "getProjectActivityCalendar").mockReturnValue(
        pending.promise,
      );
      const options = projectActivityCalendarQuery(input);
      const request = cache.fetchQuery(options).catch(() => undefined);
      if (operation === "logout") cache.clear();
      else await cache.cancelQueries({ queryKey: options.queryKey });
      pending.resolve(response());
      await request;
      await settleTransport();
      expect(cache.getQueryData(options.queryKey)).toBeUndefined();
      if (operation === "logout")
        expect(cache.getQueryCache().getAll()).toHaveLength(0);
    },
  );

  it("a canceled old account denial cannot clear the new account", async () => {
    const cache = client();
    const pending = deferred<ActivityCalendarResponse>();
    vi.spyOn(api, "getUserActivityCalendar").mockReturnValue(pending.promise);
    const request = cache
      .fetchQuery(userActivityCalendarQuery(personal))
      .catch(() => undefined);
    cache.clear();
    const next = userActivityCalendarQuery({ ...personal, viewerId: 43 });
    cache.setQueryData(next.queryKey, response());
    pending.reject(new TodouError(403, "forbidden", "No access"));
    await request;
    await settleTransport();
    expect(cache.getQueryData(next.queryKey)).toEqual(response());
    expect(cache.getQueryCache().getAll()).toHaveLength(1);
  });
});

describe("one complete activity snapshot", () => {
  it("appends cards across projects while replacing the whole calendar and response metadata", async () => {
    const cache = client();
    const first = response([card(1, 1)]);
    const next = {
      ...response([card(1, 2)], null, 8),
      read_finished_at: "2026-03-02T12:01:00.000Z",
    };
    vi.spyOn(api, "getUserActivityCalendar")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(response([card(9)]));
    const options = userActivityCalendarQuery(personal);
    await cache.fetchQuery(options);
    await loadMoreUserActivityCalendar(cache, personal);
    expect(cache.getQueryData(options.queryKey)).toEqual({
      ...next,
      selection: { ...next.selection, items: [card(1, 1), card(1, 2)] },
    });
    expect(api.getUserActivityCalendar).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ after: "page-two" }),
    );
    // A normal SSE refetch replaces appended pages with its first response.
    await cache.fetchQuery(options);
    expect(cache.getQueryData(options.queryKey)).toEqual(response([card(9)]));
  });

  it("does not merge a continuation into a refreshed generation", async () => {
    const cache = client();
    const page = deferred<ActivityCalendarResponse>();
    const first = response();
    const refreshed = response([card(7)], "new-cursor", 9);
    vi.spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(refreshed);
    const options = projectActivityCalendarQuery(input);
    await cache.fetchQuery(options);
    const more = loadMoreProjectActivityCalendar(cache, input);
    await cache.fetchQuery(options);
    page.resolve(response([card(2)], null));
    await more;
    expect(cache.getQueryData(options.queryKey)).toEqual(refreshed);
  });

  it("scope/date cancellation prevents a late continuation from restoring old data", async () => {
    const cache = client();
    const page = deferred<ActivityCalendarResponse>();
    vi.spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(page.promise);
    const options = projectActivityCalendarQuery(input);
    await cache.fetchQuery(options);
    const abort = new AbortController();
    const more = loadMoreProjectActivityCalendar(cache, input, abort.signal);
    abort.abort();
    const next = projectActivityCalendarQuery({ ...input, day: "2026-03-02" });
    expect(cache.getQueryData(next.queryKey)).toBeUndefined();
    page.resolve(response([card(2)], null));
    await more;
    await settleTransport();
    expect(cache.getQueryData(options.queryKey)).toEqual(response());
    expect(cache.getQueryData(next.queryKey)).toBeUndefined();
  });

  it("logout while paging cannot recreate either removed cache entry", async () => {
    const cache = client();
    const page = deferred<ActivityCalendarResponse>();
    vi.spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(page.promise);
    await cache.fetchQuery(projectActivityCalendarQuery(input));
    const more = loadMoreProjectActivityCalendar(cache, input);
    cache.clear();
    page.resolve(response([card(2)], null));
    await more;
    await settleTransport();
    expect(cache.getQueryCache().getAll()).toHaveLength(0);
  });

  it("a 409 discards appended pages before restarting the first response", async () => {
    const cache = client();
    const restart = deferred<ActivityCalendarResponse>();
    vi.spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([card(2)], "page-three", 4))
      .mockRejectedValueOnce(
        new TodouError(409, "conflict", "Activity changed"),
      )
      .mockReturnValueOnce(restart.promise);
    const options = projectActivityCalendarQuery(input);
    await cache.fetchQuery(options);
    await loadMoreProjectActivityCalendar(cache, input);
    expect(cache.getQueryData(options.queryKey)?.selection?.items).toHaveLength(
      2,
    );
    const more = loadMoreProjectActivityCalendar(cache, input);
    await settleTransport();
    expect(cache.getQueryData(options.queryKey)).toBeUndefined();
    expect(api.getProjectActivityCalendar).toHaveBeenLastCalledWith(
      "demo",
      expect.objectContaining({ after: undefined }),
    );
    const replacement = response([card(7)], null, 9);
    restart.resolve(replacement);
    await more;
    expect(cache.getQueryData(options.queryKey)).toEqual(replacement);
  });

  it.each(["cancel", "unmount"] as const)(
    "discarded 409 data stays absent after retry %s and late response",
    async (operation) => {
      const cache = client();
      const retry = deferred<ActivityCalendarResponse>();
      const options = projectActivityCalendarQuery(input);
      // An accumulated response from an earlier successful pagination.
      cache.setQueryData(
        options.queryKey,
        response([card(1), card(2)], "page-three"),
      );
      const observer = new QueryObserver(cache, { ...options, enabled: false });
      const unsubscribe = observer.subscribe(() => undefined);
      vi.spyOn(api, "getProjectActivityCalendar")
        .mockRejectedValueOnce(
          new TodouError(409, "conflict", "Activity changed"),
        )
        .mockReturnValueOnce(retry.promise);
      const refresh = cache.fetchQuery(options).catch(() => undefined);
      await settleTransport();
      expect(api.getProjectActivityCalendar).toHaveBeenCalledTimes(2);
      expect(cache.getQueryData(options.queryKey)).toBeUndefined();
      if (operation === "cancel")
        await cache.cancelQueries({ queryKey: options.queryKey, exact: true });
      else unsubscribe();
      expect(cache.getQueryData(options.queryKey)).toBeUndefined();
      retry.resolve(response([card(9)]));
      await refresh;
      await settleTransport();
      expect(cache.getQueryData(options.queryKey)).toBeUndefined();
      unsubscribe();
      observer.destroy();
    },
  );

  it("canceling a cached continuation cannot append its reverted cached page", async () => {
    const cache = client();
    const options = projectActivityCalendarQuery(input);
    const pageOptions = projectActivityCalendarQuery({
      ...input,
      after: "page-two",
    });
    const delayed = deferred<ActivityCalendarResponse>();
    cache.setQueryData(options.queryKey, response());
    cache.setQueryData(pageOptions.queryKey, response([card(2)], null));
    vi.spyOn(api, "getProjectActivityCalendar").mockReturnValue(
      delayed.promise,
    );
    const more = loadMoreProjectActivityCalendar(cache, input);
    await cache.cancelQueries({ queryKey: pageOptions.queryKey, exact: true });
    await more;
    expect(cache.getQueryData(options.queryKey)).toEqual(response());
    delayed.resolve(response([card(9)], null));
    await settleTransport();
    expect(cache.getQueryData(options.queryKey)).toEqual(response());
  });

  it("a failed restart cannot restore a discarded snapshot and repeated 409s stop", async () => {
    const cache = client();
    const conflict = new TodouError(409, "conflict", "Activity changed");
    vi.spyOn(api, "getProjectActivityCalendar")
      .mockResolvedValueOnce(response())
      .mockRejectedValue(conflict);
    const options = projectActivityCalendarQuery(input);
    await cache.fetchQuery(options);
    await expect(loadMoreProjectActivityCalendar(cache, input)).rejects.toBe(
      conflict,
    );
    expect(cache.getQueryData(options.queryKey)).toBeUndefined();
    expect(api.getProjectActivityCalendar).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403, 404])(
    "permission %s clears first and appended activity snapshots for the viewer",
    async (status) => {
      const cache = client();
      const denial = new TodouError(status, "forbidden", "No access");
      vi.spyOn(api, "getProjectActivityCalendar")
        .mockResolvedValueOnce(response())
        .mockRejectedValueOnce(denial);
      const options = projectActivityCalendarQuery(input);
      const otherScope = userActivityCalendarQuery(personal);
      const otherViewer = userActivityCalendarQuery({
        ...personal,
        viewerId: 43,
      });
      await cache.fetchQuery(options);
      cache.setQueryData(otherScope.queryKey, response());
      cache.setQueryData(otherViewer.queryKey, response());
      await expect(loadMoreProjectActivityCalendar(cache, input)).rejects.toBe(
        denial,
      );
      expect(cache.getQueryData(options.queryKey)).toBeUndefined();
      expect(cache.getQueryState(options.queryKey)?.error).toBe(denial);
      expect(cache.getQueryData(otherScope.queryKey)).toBeUndefined();
      expect(cache.getQueryData(otherViewer.queryKey)).toEqual(response());
    },
  );

  it("first-response permission failure clears cached data and cancels other reads for that viewer", async () => {
    const cache = client();
    const delayed = deferred<ActivityCalendarResponse>();
    const denial = new TodouError(404, "not_found", "Not visible");
    vi.spyOn(api, "getUserActivityCalendar").mockReturnValue(delayed.promise);
    vi.spyOn(api, "getProjectActivityCalendar").mockRejectedValue(denial);
    const options = projectActivityCalendarQuery(input);
    const userOptions = userActivityCalendarQuery(personal);
    cache.setQueryData(options.queryKey, response());
    cache.setQueryData(userOptions.queryKey, response());
    const userRead = cache.fetchQuery(userOptions).catch(() => undefined);
    await expect(cache.fetchQuery(options)).rejects.toBe(denial);
    delayed.resolve(response([card(8)]));
    await userRead;
    await settleTransport();
    expect(cache.getQueryData(options.queryKey)).toBeUndefined();
    expect(cache.getQueryData(userOptions.queryKey)).toBeUndefined();
    expect(cache.getQueryState(options.queryKey)?.status).toBe("error");
  });

  it.each(["refresh", "page"] as const)(
    "ordinary %s failure preserves the complete previous snapshot",
    async (operation) => {
      const cache = client();
      const offline = new Error("Offline");
      vi.spyOn(api, "getProjectActivityCalendar")
        .mockResolvedValueOnce(response())
        .mockRejectedValueOnce(offline);
      const options = projectActivityCalendarQuery(input);
      await cache.fetchQuery(options);
      const old = cache.getQueryData(options.queryKey);
      const request =
        operation === "refresh"
          ? cache.fetchQuery(options)
          : loadMoreProjectActivityCalendar(cache, input);
      await expect(request).rejects.toBe(offline);
      expect(cache.getQueryData(options.queryKey)).toBe(old);
    },
  );
});
