import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import type { ActivityCalendarResponse, PublicUser } from "@todou/shared";
import * as sonner from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userActivityCalendarQuery } from "../src/api/activity-calendar.ts";
import { api, meQuery, queryClient } from "../src/api/queries.ts";
import { userQuery, userSearchSchema } from "../src/api/users.ts";
import { router as appRouter } from "../src/router.tsx";

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

vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof sonner>();
  return {
    ...actual,
    toast: Object.assign(
      vi.fn(() => "invalid-date"),
      actual.toast,
    ),
  };
});

const alice: PublicUser = {
  id: 7,
  login: "alice",
  display_name: "Alice Potato",
  kind: "human",
  avatar_url: null,
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
};

const bot: PublicUser = {
  id: 8,
  login: "bot-one",
  display_name: "A Bot",
  kind: "machine",
  avatar_url: null,
  owner: { id: 7, login: "alice" },
  created_at: "2026-02-01T00:00:00Z",
};

const Root = createRootRoute();

// Use the registered production component: its route hooks require this exact
// pathless parent id, even though the public URL remains /users/$ref.
const Authed = createRoute({ getParentRoute: () => Root, id: "authed" });

const Route = createRoute({
  getParentRoute: () => Authed,
  path: "/users/$ref",
  component: appRouter.routesById["/authed/users/$ref"].options.component,
  validateSearch: userSearchSchema,
  search: appRouter.routesById["/authed/users/$ref"].options.search,
});

/**
 * Render the user page at a real router address, so a test arrives the way
 * a reader does: by URL.
 */
function renderAt(path: string, client: QueryClient) {
  client.setQueryData(meQuery.queryKey, {
    ...alice,
    id: 42,
    login: "viewer",
    email: "viewer@example.com",
    is_instance_admin: false,
  });
  const router = createRouter({
    routeTree: Root.addChildren([Authed.addChildren([Route])]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router };
}

/**
 * A real flush: one macrotask, so React commits and react-query settles.
 * `await Promise.resolve()` drains microtasks only, and the same probe run
 * behind one reports the opposite of what a settled cache holds.
 */
const settle = async (ms = 300) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const clientWith = (data: PublicUser): QueryClient => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(userQuery(data.login).queryKey, data);
  return client;
};

/** Answers both spellings: the id load, then the login page it redirects to. */
const clientWithId = (data: PublicUser, id: number): QueryClient => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(userQuery(String(id)).queryKey, data);
  client.setQueryData(userQuery(data.login).queryKey, data);
  return client;
};

// No recorded days means the identity/no-date cases keep their original URL.
// Calendar-specific cases below replace this endpoint with recorded dates.
beforeEach(() => {
  // The calendar window rolls off the clock, so pin Date (and only Date, so
  // waitFor still runs) or these request assertions would drift every week.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  vi.mocked(sonner.toast).mockClear();
  vi.spyOn(api, "me").mockResolvedValue({
    ...alice,
    id: 42,
    login: "viewer",
    email: "viewer@example.com",
    is_instance_admin: false,
  });
  vi.spyOn(api, "listUserIssues").mockResolvedValue({
    items: [],
    next_cursor: null,
    has_more: false,
  });
  vi.spyOn(api, "listUserProjects").mockResolvedValue({ items: [] });
  vi.spyOn(api, "getUserActivityCalendar").mockImplementation(
    async (_subject, input) => ({
      from: String(input.from),
      to: String(input.to),
      timezone: input.tz,
      cutoff: "2026-09-19T12:00:00Z",
      read_started_at: "2026-09-19T12:00:00Z",
      read_finished_at: "2026-09-19T12:00:00Z",
      days: [],
      selection: null,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("UserProfilePage (T-373)", () => {
  it("shows the identity facts by login", async () => {
    const view = renderAt("/users/alice", clientWith(alice));
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    expect(view.getByText("@alice")).toBeTruthy();
    expect(view.getByText(/joined/)).toBeTruthy();
  });

  it("names the machine account and its owner", async () => {
    const view = renderAt("/users/bot-one", clientWith(bot));
    expect(await view.findByText(/agent · belongs to @alice/)).toBeTruthy();
  });

  it("shows an explanation on 404, not a blank page", async () => {
    vi.spyOn(api, "getUser").mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    const view = renderAt(
      "/users/alice",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    expect(await view.findByText("No such user here")).toBeTruthy();
    // 404 is an empty state, not a failure: there is nothing to retry into.
    // Green before this card too — a fence against "swap the whole isError
    // block for a LoadFailure", not evidence the card was fixed.
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("carries no email anywhere in the payload it renders", async () => {
    const view = renderAt("/users/alice", clientWith(alice));
    await view.findByText("Alice Potato");
    expect(view.container.textContent).not.toContain("@example");
    expect("email" in alice).toBe(false);
  });

  it("an id address redirects to the login one, replacing history", async () => {
    // The path every stored mention link actually takes: `/users/7` loads
    // by id, then hands the reader to `/users/alice` with replace.
    const view = renderAt("/users/7", clientWithId(alice, 7));
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    expect(view.router.state.location.pathname).toBe("/users/alice");
    // Replace, not push: the id form never lingers in history.
    expect(view.router.history.canGoBack()).toBe(false);
  });
});

describe("UserProfilePage load failure (T-409)", () => {
  it("offers Retry on a non-404 failure, and recovers when the read succeeds", async () => {
    let failing = true;
    const getUser = vi.spyOn(api, "getUser").mockImplementation(async () => {
      if (failing) {
        throw Object.assign(new Error("server on fire"), { status: 500 });
      }
      return alice;
    });
    const view = renderAt(
      "/users/alice",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await view.findByText(/Could not load this user/);
    expect(view.queryByText("Try again in a moment.")).toBeNull();
    expect(getUser).toHaveBeenCalledTimes(1);

    failing = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    // The ref each call asked for, not just the count: a retry bound to the
    // wrong query would still reach two calls.
    expect(getUser.mock.calls.map((c) => c[0])).toEqual(["alice", "alice"]);
  });

  it("retries the ref the page is actually showing", async () => {
    // What the previous case cannot catch: its ref is "alice" throughout, so
    // a retry bound to a hardcoded "alice" passes it. This one is a different
    // account, so a ref-insensitive retry refetches the wrong query and the
    // page never resolves.
    let failing = true;
    const getUser = vi.spyOn(api, "getUser").mockImplementation(async () => {
      if (failing) {
        throw Object.assign(new Error("server on fire"), { status: 503 });
      }
      return bot;
    });
    const view = renderAt(
      "/users/bot-one",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await view.findByText(/Could not load this user/);

    failing = false;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    expect(await view.findByText("A Bot")).toBeTruthy();
    expect(getUser.mock.calls.map((c) => c[0])).toEqual(["bot-one", "bot-one"]);
  });

  it("keeps Alice on screen and greys the refresh Retry while fetching saved data", async () => {
    // A cached read can fail without losing its data. The warning must be
    // a sibling of that identity, not a replacement for it.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(userQuery("alice").queryKey, alice);
    const view = renderAt("/users/alice", client);
    await view.findByText("Alice Potato");

    vi.spyOn(api, "getUser").mockRejectedValue(
      Object.assign(new Error("server on fire"), { status: 500 }),
    );
    await act(async () => {
      await client.refetchQueries({ queryKey: userQuery("alice").queryKey });
    });
    await waitFor(() =>
      expect(client.getQueryState(userQuery("alice").queryKey)?.status).toBe(
        "error",
      ),
    );
    expect(view.getByText("Alice Potato")).toBeTruthy();
    const warning = await view.findByText(/Couldn't refresh this user/);
    const warningRow = warning.closest('[role="status"]');
    expect(warningRow).not.toBeNull();
    const retryButton = within(warningRow as HTMLElement).getByRole("button", {
      name: "Retry",
    });

    let resolveRetry: (user: PublicUser) => void = () => undefined;
    const retry = new Promise<PublicUser>((resolve) => {
      resolveRetry = resolve;
    });
    vi.spyOn(api, "getUser").mockReturnValue(retry);
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(retryButton.hasAttribute("disabled")).toBe(true);
    });
    expect(view.getByText("Alice Potato")).toBeTruthy();
    expect(view.getByText(/Couldn't refresh this user/)).toBeTruthy();

    await act(async () => {
      resolveRetry({ ...alice, display_name: "Alice Recovered" });
    });
    expect(await view.findByText("Alice Recovered")).toBeTruthy();
    expect(view.queryByText(/Couldn't refresh this user/)).toBeNull();
  });
});

describe("UserProfilePage · saved data policy (T-415)", () => {
  it.each([403, 404])(
    "removes cached identity on a refused %s read",
    async (status) => {
      const client = clientWith(alice);
      const view = renderAt("/users/alice", client);
      await view.findByText("Alice Potato");
      vi.spyOn(api, "getUser").mockRejectedValue(
        Object.assign(new Error("access refused"), { status }),
      );
      await act(async () => {
        await client.refetchQueries({ queryKey: userQuery("alice").queryKey });
      });
      if (status === 404) {
        await view.findByText("No such user here");
        expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
      } else {
        await view.findByText(/Could not load this user: access refused/);
      }
      expect(view.queryByText("Alice Potato")).toBeNull();
      expect(view.queryByText(/Couldn't refresh/)).toBeNull();
    },
  );

  it("keeps cached identity on a network failure and Retry recovers", async () => {
    const client = clientWith(alice);
    const view = renderAt("/users/alice", client);
    await view.findByText("Alice Potato");
    const get = vi
      .spyOn(api, "getUser")
      .mockRejectedValue(new TypeError("offline"));
    await act(async () => {
      await client.refetchQueries({ queryKey: userQuery("alice").queryKey });
    });
    const warning = await view.findByText(
      /Couldn't refresh this user \(offline\)/,
    );
    expect(view.getByText("Alice Potato")).toBeTruthy();
    get.mockResolvedValue({ ...alice, display_name: "Alice Online" });
    const warningRow = warning.closest('[role="status"]');
    expect(warningRow).not.toBeNull();
    fireEvent.click(
      within(warningRow as HTMLElement).getByRole("button", { name: "Retry" }),
    );
    await view.findByText("Alice Online");
    expect(view.queryByText(/Couldn't refresh/)).toBeNull();
  });
});

describe("the id address under a failing read (T-414)", () => {
  it("asks once on a 404 and shows the empty state", async () => {
    const getUser = vi
      .spyOn(api, "getUser")
      .mockRejectedValue(
        Object.assign(new Error("not found"), { status: 404 }),
      );
    const view = renderAt(
      "/users/7",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    // Count first, read the screen second: without the fix this line reports
    // the real number (thousands) instead of timing out waiting for text.
    await settle();
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(view.getByText("No such user here")).toBeTruthy();
  });

  it("stops at the production retry bound on a 5xx", async () => {
    const getUser = vi
      .spyOn(api, "getUser")
      .mockRejectedValue(
        Object.assign(new Error("server on fire"), { status: 503 }),
      );
    // The production retry predicate itself, not a copy of it: 5xx retries
    // twice, 4xx not at all. Only retryDelay is overridden, to drop the 1s + 2s
    // backoff this case would otherwise spend waiting.
    const client = new QueryClient({
      defaultOptions: {
        queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
      },
    });
    const view = renderAt("/users/7", client);
    await settle();
    expect(getUser.mock.calls.length).toBeLessThanOrEqual(3);
    expect(view.getByText(/Could not load this user/)).toBeTruthy();
  });

  it("reads the account once when it arrives by id", async () => {
    const getUser = vi.spyOn(api, "getUser").mockResolvedValue(alice);
    // Both spellings start cold: clientWithId seeds each of them, and that is
    // exactly what covers up the second read.
    const view = renderAt(
      "/users/7",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    expect(await view.findByText("Alice Potato")).toBeTruthy();
    expect(view.router.state.location.pathname).toBe("/users/alice");
    expect(getUser.mock.calls.map((c) => c[0])).toEqual(["7"]);
  });

  it("carries the filters through the redirect", async () => {
    vi.spyOn(api, "getUser").mockResolvedValue(alice);
    const view = renderAt(
      "/users/7?role=assignee&state=all",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await view.findByText("Alice Potato");
    expect(view.router.state.location.pathname).toBe("/users/alice");
    expect(view.router.state.location.search).toEqual({
      role: "assignee",
      state: "all",
    });
  });
});

function recordedCalendar(
  input: Parameters<typeof api.getUserActivityCalendar>[1],
): ActivityCalendarResponse {
  const from = String(input.from);
  const to = String(input.to);
  const start = Date.parse(`${from}T00:00:00Z`);
  const count = (Date.parse(`${to}T00:00:00Z`) - start) / 86_400_000;
  return {
    from,
    to,
    timezone: input.tz,
    cutoff: "2026-09-19T12:00:00Z",
    read_started_at: "2026-09-19T12:00:00Z",
    read_finished_at: "2026-09-19T12:00:00Z",
    days: Array.from({ length: count }, (_, index) => {
      const date = new Date(start + index * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return { date, ...dayBounds(date), state: "recorded" as const, count: 0 };
    }),
    selection: input.day
      ? {
          date: input.day,
          total: 0,
          items: [],
          next_cursor: null,
          has_more: false,
        }
      : null,
  };
}

describe("the registered user route's activity dates", () => {
  const dates = { activity_day: "2026-03-04" };
  const search = { role: "assignee", state: "closed", ...dates };
  const address = "?role=assignee&state=closed&activity_day=2026-03-04";

  beforeEach(() => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...options,
      timeZone: "Asia/Tokyo",
    });
    vi.mocked(api.getUserActivityCalendar).mockImplementation(
      async (_subject, input) => recordedCalendar(input),
    );
  });

  it.each(["alice", "7"])(
    "ignores a raw URL boolean marker at /users/%s",
    async (ref) => {
      const view = renderAt(
        `/users/${ref}${address}&activity_invalid=true`,
        clientWithId(alice, 7),
      );
      await view.findByText("No active cards on 2026-03-04.");
      // The real TanStack parser decodes unquoted true as a boolean.
      expect(
        view.router.options.parseSearch!("?activity_invalid=true"),
      ).toEqual({
        activity_invalid: true,
      });
      expect(sonner.toast).not.toHaveBeenCalled();
      const linked = view.router.buildLocation({
        to: "/users/$ref",
        params: { ref: "alice" },
        search: true,
        _includeValidateSearch: true,
      });
      expect(
        new URLSearchParams(linked.searchStr).has("activity_invalid"),
      ).toBe(false);
      // Link target validation can derive fresh notice metadata too. Keep the
      // actual invalid input so the destination can notify, but never the flag.
      const invalidLink = view.router.buildLocation({
        to: "/users/$ref",
        params: { ref: "alice" },
        search: {
          role: "author",
          activity_day: "2026-02-30",
        },
        _includeValidateSearch: true,
      });
      expect(
        new URLSearchParams(invalidLink.searchStr).get("activity_day"),
      ).toBe("2026-02-30");
      expect(
        new URLSearchParams(invalidLink.searchStr).has("activity_invalid"),
      ).toBe(false);
      // The cards and the filters that govern them are not on the page while
      // a day stands in their place, so the route back to them is the
      // calendar's own control.
      fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual({
          role: "assignee",
          state: "closed",
        }),
      );
      fireEvent.click(await view.findByRole("tab", { name: "Created" }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual({
          role: "author",
          state: "closed",
        }),
      );
      expect(view.router.state.location.searchStr).not.toContain(
        "activity_invalid",
      );
      expect(sonner.toast).not.toHaveBeenCalled();
    },
  );

  it.each(["alice", "7"])(
    "normalizes a genuine invalid date at /users/%s before role/state changes and reopening",
    async (ref) => {
      // No recorded fallback: normalization must not depend on the calendar
      // supplying a default or the reader choosing a day.
      vi.mocked(api.getUserActivityCalendar).mockImplementation(
        async (_subject, input) => ({
          ...recordedCalendar(input),
          days: [],
          selection: null,
        }),
      );
      const view = renderAt(
        `/users/${ref}?role=assignee&state=closed&activity_day=2026-02-30`,
        clientWithId(alice, 7),
      );
      await view.findByText("No available dates in this range.");
      const normalized = {
        role: "assignee",
        state: "closed",
      };
      await waitFor(() => {
        expect(view.router.state.location.pathname).toBe("/users/alice");
        expect(view.router.state.location.search).toEqual(normalized);
        expect(sonner.toast).toHaveBeenCalledExactlyOnceWith(
          "Invalid activity date was reset.",
        );
      });
      expect(view.router.history.canGoBack()).toBe(false);
      fireEvent.click(view.getByRole("tab", { name: "Created" }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual({
          ...normalized,
          role: "author",
        }),
      );
      fireEvent.click(view.getByRole("tab", { name: "Open" }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual({
          role: "author",
        }),
      );
      const shared = view.router.state.location.href;
      expect(shared).not.toContain("activity_invalid");
      expect(shared).not.toContain("2026-02-30");
      view.unmount();
      vi.mocked(sonner.toast).mockClear();
      const reopened = renderAt(shared, clientWith(alice));
      await reopened.findByText("No available dates in this range.");
      expect(reopened.router.state.location.search).toEqual({
        role: "author",
      });
      expect(sonner.toast).not.toHaveBeenCalled();
    },
  );

  it("loads the numeric subject in the viewer's cache and ignores URL timezone", async () => {
    const client = clientWith(alice);
    const view = renderAt(`/users/alice${address}&tz=Pacific/Honolulu`, client);
    await view.findByText("No active cards on 2026-03-04.");
    expect(api.getUserActivityCalendar).toHaveBeenCalledWith(7, {
      from: "2025-09-22",
      to: "2026-09-20",
      day: "2026-03-04",
      tz: "Asia/Tokyo",
      limit: 50,
      after: undefined,
    });
    const request = {
      viewerId: 42,
      subjectId: 7,
      from: "2025-09-22",
      to: "2026-09-20",
      day: "2026-03-04",
      tz: "Asia/Tokyo",
    };
    expect(
      client.getQueryData(userActivityCalendarQuery(request).queryKey),
    ).toMatchObject({
      from: "2025-09-22",
      to: "2026-09-20",
      timezone: "Asia/Tokyo",
    });
    expect(
      client.getQueryData(
        userActivityCalendarQuery({ ...request, viewerId: 7 }).queryKey,
      ),
    ).toBeUndefined();
    expect(view.queryByRole("spinbutton", { name: "Year" })).toBeNull();
    expect(userSearchSchema(view.router.state.location.search)).toEqual(search);
    expect(view.router.state.location.search).toEqual({
      ...search,
      tz: "Pacific/Honolulu",
    });
    fireEvent.click(view.getByRole("button", { name: /^2026-03-05\b/ }));
    await view.findByText("No active cards on 2026-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2026-03-05",
    });
    expect(api.getUserActivityCalendar).toHaveBeenLastCalledWith(7, {
      from: "2025-09-22",
      to: "2026-09-20",
      day: "2026-03-05",
      tz: "Asia/Tokyo",
      limit: 50,
      after: undefined,
    });
  });

  it("keeps role and state across day selections and history", async () => {
    const view = renderAt(`/users/alice${address}`, clientWith(alice));
    await view.findByText("No active cards on 2026-03-04.");
    fireEvent.click(view.getByRole("button", { name: /^2026-03-05\b/ }));
    await view.findByText("No active cards on 2026-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2026-03-05",
    });
    fireEvent.click(view.getByRole("button", { name: /^2026-03-06\b/ }));
    await view.findByText("No active cards on 2026-03-06.");
    expect(view.router.history.canGoBack()).toBe(true);
    act(() => view.router.history.back());
    await view.findByText("No active cards on 2026-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2026-03-05",
    });
    act(() => view.router.history.back());
    await view.findByText("No active cards on 2026-03-04.");
    expect(view.router.state.location.search).toEqual(search);
    act(() => view.router.history.forward());
    await view.findByText("No active cards on 2026-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2026-03-05",
    });
  });

  it("puts the day's cards where the cards and their filters were, until the selection is cleared", async () => {
    const view = renderAt(`/users/alice${address}`, clientWith(alice));
    await view.findByText("No active cards on 2026-03-04.");
    // Filters with nothing on screen to filter: the list they govern is the
    // one the day replaced.
    expect(view.queryByRole("tablist", { name: "Involvement" })).toBeNull();
    expect(view.queryByRole("heading", { name: "Their cards" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        role: "assignee",
        state: "closed",
      }),
    );
    expect(
      await view.findByRole("heading", { name: "Their cards" }),
    ).toBeTruthy();
    expect(view.queryByText("No active cards on 2026-03-04.")).toBeNull();
    // Back is what undoes the clearing: it was the reader's own selection,
    // not a default chosen for them.
    expect(view.router.history.canGoBack()).toBe(true);
    act(() => view.router.history.back());
    await view.findByText("No active cards on 2026-03-04.");
    expect(view.router.state.location.search).toEqual(search);
    expect(view.queryByRole("tablist", { name: "Involvement" })).toBeNull();
  });

  it("resets both filter defaults out of the URL", async () => {
    const view = renderAt(
      "/users/alice?role=assignee&state=closed",
      clientWith(alice),
    );
    fireEvent.click(await view.findByRole("tab", { name: "Created" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        role: "author",
        state: "closed",
      }),
    );
    fireEvent.click(
      within(view.getByRole("tablist", { name: "State" })).getByRole("tab", {
        name: "All",
      }),
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        role: "author",
        state: "all",
      }),
    );
    fireEvent.click(
      within(view.getByRole("tablist", { name: "Involvement" })).getByRole(
        "tab",
        { name: "All" },
      ),
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ state: "all" }),
    );
    fireEvent.click(view.getByRole("tab", { name: "Open" }));
    await waitFor(() => expect(view.router.state.location.search).toEqual({}));
    expect(view.router.history.canGoBack()).toBe(false);
  });

  it("replaces a numeric address with the complete date and filter search", async () => {
    const view = renderAt(`/users/7${address}`, clientWithId(alice, 7));
    await view.findByText("No active cards on 2026-03-04.");
    expect(view.router.state.location.pathname).toBe("/users/alice");
    expect(view.router.state.location.search).toEqual(search);
    expect(view.router.history.canGoBack()).toBe(false);
    // The filters carried through the redirect are still the ones in force;
    // the day's cards are simply standing where the list they govern was.
    fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
    expect(
      (await view.findByRole("tab", { name: "Assigned" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(
      view.getByRole("tab", { name: "Closed" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it.each(["partially unavailable", "all unavailable"] as const)(
    "resets a server-rejected day with one notice when dates are %s",
    async (availability) => {
      vi.mocked(api.getUserActivityCalendar).mockImplementation(
        async (_subject, input) => {
          const response = recordedCalendar(input);
          return {
            ...response,
            days: response.days.map((day) =>
              availability === "all unavailable" || day.date === "2026-03-04"
                ? {
                    date: day.date,
                    ...dayBounds(day.date),
                    state: "not_applicable" as const,
                    count: null,
                  }
                : day,
            ),
          };
        },
      );
      const view = renderAt(`/users/alice${address}`, clientWith(alice));
      // Either way the rejected day is cleared rather than replaced, so no
      // card list is rendered and no day sits in the URL.
      if (availability === "all unavailable") {
        await view.findByText("No available dates in this range.");
      }
      await waitFor(() => {
        expect(
          view.queryByRole("region", { name: "Selected day activity" }),
        ).toBeNull();
        expect(view.router.state.location.search).toEqual({
          role: "assignee",
          state: "closed",
        });
        expect(sonner.toast).toHaveBeenCalledExactlyOnceWith(
          "Invalid activity date was reset.",
        );
      });
      expect(view.router.history.canGoBack()).toBe(false);
      expect(api.getUserActivityCalendar).not.toHaveBeenCalledWith(
        7,
        expect.objectContaining({ day: "2026-03-04" }),
      );
      fireEvent.click(view.getByRole("tab", { name: "Created" }));
      await waitFor(() =>
        expect(view.router.state.location.search.role).toBe("author"),
      );
      expect(sonner.toast).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves an empty window with no requested day quiet", async () => {
    vi.mocked(api.getUserActivityCalendar).mockImplementation(
      async (_subject, input) => {
        const response = recordedCalendar(input);
        return {
          ...response,
          days: response.days.map((day) => ({
            date: day.date,
            ...dayBounds(day.date),
            state: "not_applicable" as const,
            count: null,
          })),
        };
      },
    );
    const view = renderAt(
      "/users/alice?role=assignee&state=closed",
      clientWith(alice),
    );
    await view.findByText("No available dates in this range.");
    expect(view.router.state.location.search).toEqual({
      role: "assignee",
      state: "closed",
    });
    expect(sonner.toast).not.toHaveBeenCalled();
    expect(view.router.history.canGoBack()).toBe(false);
  });

  it("notifies once and normalizes the id redirect while a cached calendar refresh is pending", async () => {
    const notify = vi.mocked(sonner.toast);
    let resolveRefresh!: (value: ActivityCalendarResponse) => void;
    const refresh = {
      promise: new Promise<ActivityCalendarResponse>((resolve) => {
        resolveRefresh = resolve;
      }),
      resolve: (value: ActivityCalendarResponse) => resolveRefresh(value),
    };
    const request = {
      viewerId: 42,
      subjectId: 7,
      from: "2025-09-22",
      to: "2026-09-20",
      tz: "Asia/Tokyo",
    };
    const calendar = recordedCalendar(request);
    const client = clientWithId(alice, 7);
    // A cached grid remains usable while its refresh is pending. Normalizing
    // the invalid URL must not wait for that refresh or a manual selection.
    client.setQueryData(userActivityCalendarQuery(request).queryKey, calendar);
    vi.mocked(api.getUserActivityCalendar).mockImplementation(
      async (_subject, input) =>
        input.day ? recordedCalendar(input) : refresh.promise,
    );
    const view = renderAt(
      "/users/7?role=assignee&state=closed&activity_day=2026-02-30",
      client,
    );
    try {
      await view.findByRole("button", { name: /^2026-03-04\b/ });
      await waitFor(() => {
        expect(view.router.state.location.pathname).toBe("/users/alice");
        expect(view.router.state.location.search).toEqual({
          role: "assignee",
          state: "closed",
        });
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          "Invalid activity date was reset.",
        );
      });
      expect(userSearchSchema(view.router.state.location.search)).toEqual({
        role: "assignee",
        state: "closed",
      });
      expect(view.router.history.canGoBack()).toBe(false);
      fireEvent.click(view.getByRole("button", { name: /^2026-03-04\b/ }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual(search),
      );
      await act(async () => refresh.resolve(calendar));
      await view.findByText("No active cards on 2026-03-04.");
      await settle();
      expect(view.router.state.location.search).toEqual(search);
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "Invalid activity date was reset.",
      );
      fireEvent.click(view.getByRole("button", { name: "Clear selection" }));
      expect(
        (await view.findByRole("tab", { name: "Assigned" })).getAttribute(
          "aria-selected",
        ),
      ).toBe("true");
      expect(
        view.getByRole("tab", { name: "Closed" }).getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      refresh.resolve(calendar);
      view.unmount();
    }
  });
});
