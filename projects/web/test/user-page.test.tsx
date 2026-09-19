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
      year: Number(input.year),
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
  const year = Number(input.year);
  const start = Date.UTC(year, 0, 1);
  const count = (Date.UTC(year + 1, 0, 1) - start) / 86_400_000;
  return {
    year,
    timezone: input.tz,
    cutoff: "2026-09-19T12:00:00Z",
    read_started_at: "2026-09-19T12:00:00Z",
    read_finished_at: "2026-09-19T12:00:00Z",
    days: Array.from({ length: count }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      state: "recorded" as const,
      count: 0,
    })),
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
  const dates = { activity_year: 2025, activity_day: "2025-03-04" };
  const search = { role: "assignee", state: "closed", ...dates };
  const address =
    "?role=assignee&state=closed&activity_year=2025&activity_day=2025-03-04";

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

  it("loads the numeric subject in the viewer's cache and ignores URL timezone", async () => {
    const client = clientWith(alice);
    const view = renderAt(`/users/alice${address}&tz=Pacific/Honolulu`, client);
    await view.findByText("No active cards on 2025-03-04.");
    expect(api.getUserActivityCalendar).toHaveBeenCalledWith(7, {
      year: 2025,
      day: "2025-03-04",
      tz: "Asia/Tokyo",
      limit: 50,
      after: undefined,
    });
    const request = {
      viewerId: 42,
      subjectId: 7,
      year: 2025,
      day: "2025-03-04",
      tz: "Asia/Tokyo",
    };
    expect(
      client.getQueryData(userActivityCalendarQuery(request).queryKey),
    ).toMatchObject({ year: 2025, timezone: "Asia/Tokyo" });
    expect(
      client.getQueryData(
        userActivityCalendarQuery({ ...request, viewerId: 7 }).queryKey,
      ),
    ).toBeUndefined();
    expect(
      (view.getByRole("spinbutton", { name: "Year" }) as HTMLInputElement)
        .value,
    ).toBe("2025");
    expect(userSearchSchema(view.router.state.location.search)).toEqual(search);
    expect(view.router.state.location.search).toEqual({
      ...search,
      tz: "Pacific/Honolulu",
    });
    fireEvent.click(view.getByRole("button", { name: /^2025-03-05\b/ }));
    await view.findByText("No active cards on 2025-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2025-03-05",
    });
    expect(api.getUserActivityCalendar).toHaveBeenLastCalledWith(7, {
      year: 2025,
      day: "2025-03-05",
      tz: "Asia/Tokyo",
      limit: 50,
      after: undefined,
    });
  });

  it("keeps role and state when selecting a day and another year", async () => {
    const view = renderAt(`/users/alice${address}`, clientWith(alice));
    await view.findByText("No active cards on 2025-03-04.");
    fireEvent.click(view.getByRole("button", { name: /^2025-03-05\b/ }));
    await view.findByText("No active cards on 2025-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2025-03-05",
    });

    fireEvent.change(view.getByRole("spinbutton", { name: "Year" }), {
      target: { value: "2024" },
    });
    // The server supplies the last recorded date in the newly chosen year.
    await view.findByText("No active cards on 2024-12-31.");
    expect(view.router.state.location.search).toEqual({
      role: "assignee",
      state: "closed",
      activity_year: 2024,
      activity_day: "2024-12-31",
    });
    expect(view.router.history.canGoBack()).toBe(true);
    act(() => view.router.history.back());
    await view.findByText("No active cards on 2025-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2025-03-05",
    });
    act(() => view.router.history.back());
    await view.findByText("No active cards on 2025-03-04.");
    expect(view.router.state.location.search).toEqual(search);
    act(() => view.router.history.forward());
    await view.findByText("No active cards on 2025-03-05.");
    expect(view.router.state.location.search).toEqual({
      ...search,
      activity_day: "2025-03-05",
    });
    act(() => view.router.history.forward());
    await view.findByText("No active cards on 2024-12-31.");
    expect(view.router.state.location.search).toEqual({
      role: "assignee",
      state: "closed",
      activity_year: 2024,
      activity_day: "2024-12-31",
    });
  });

  it("keeps dates through role/state changes and resetting both defaults", async () => {
    const view = renderAt(`/users/alice${address}`, clientWith(alice));
    await view.findByText("No active cards on 2025-03-04.");
    fireEvent.click(view.getByRole("tab", { name: "Created" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...search,
        role: "author",
      }),
    );
    fireEvent.click(
      within(view.getByRole("tablist", { name: "State" })).getByRole("tab", {
        name: "All",
      }),
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...dates,
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
      expect(view.router.state.location.search).toEqual({
        ...dates,
        state: "all",
      }),
    );
    fireEvent.click(view.getByRole("tab", { name: "Open" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual(dates),
    );
    expect(view.getByText("No active cards on 2025-03-04.")).toBeTruthy();
    expect(view.router.history.canGoBack()).toBe(false);
  });

  it("replaces a numeric address with the complete date and filter search", async () => {
    const view = renderAt(`/users/7${address}`, clientWithId(alice, 7));
    await view.findByText("No active cards on 2025-03-04.");
    expect(view.router.state.location.pathname).toBe("/users/alice");
    expect(view.router.state.location.search).toEqual(search);
    expect(view.router.history.canGoBack()).toBe(false);
    expect(
      view.getByRole("tab", { name: "Assigned" }).getAttribute("aria-selected"),
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
              availability === "all unavailable" || day.date === "2025-03-04"
                ? {
                    date: day.date,
                    state: "not_applicable" as const,
                    count: null,
                  }
                : day,
            ),
          };
        },
      );
      const view = renderAt(`/users/alice${address}`, clientWith(alice));
      if (availability === "all unavailable") {
        await view.findByText("No available dates in 2025.");
      } else {
        await view.findByText("No active cards on 2025-12-31.");
      }
      await waitFor(() => {
        expect(view.router.state.location.search).toEqual({
          role: "assignee",
          state: "closed",
          activity_year: 2025,
          ...(availability === "all unavailable"
            ? {}
            : { activity_day: "2025-12-31" }),
        });
        expect(sonner.toast).toHaveBeenCalledExactlyOnceWith(
          "Invalid activity date was reset.",
        );
      });
      expect(view.router.history.canGoBack()).toBe(false);
      expect(api.getUserActivityCalendar).not.toHaveBeenCalledWith(
        7,
        expect.objectContaining({ day: "2025-03-04" }),
      );
      fireEvent.click(view.getByRole("tab", { name: "Created" }));
      await waitFor(() =>
        expect(view.router.state.location.search.role).toBe("author"),
      );
      expect(sonner.toast).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves an empty year with no requested day quiet", async () => {
    vi.mocked(api.getUserActivityCalendar).mockImplementation(
      async (_subject, input) => {
        const response = recordedCalendar(input);
        return {
          ...response,
          days: response.days.map((day) => ({
            date: day.date,
            state: "not_applicable" as const,
            count: null,
          })),
        };
      },
    );
    const view = renderAt(
      "/users/alice?role=assignee&state=closed&activity_year=2025",
      clientWith(alice),
    );
    await view.findByText("No available dates in 2025.");
    expect(view.router.state.location.search).toEqual({
      role: "assignee",
      state: "closed",
      activity_year: 2025,
    });
    expect(sonner.toast).not.toHaveBeenCalled();
    expect(view.router.history.canGoBack()).toBe(false);
  });

  it("carries an invalid date through the id redirect, notifies once, and clears it on selection", async () => {
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
      year: 2025,
      tz: "Asia/Tokyo",
    };
    const calendar = recordedCalendar(request);
    const client = clientWithId(alice, 7);
    // A cached grid is usable while its refresh is pending. Holding that
    // response also prevents automatic defaulting from clearing the marker
    // before the reader chooses a valid day.
    client.setQueryData(userActivityCalendarQuery(request).queryKey, calendar);
    vi.mocked(api.getUserActivityCalendar).mockImplementation(
      async (_subject, input) =>
        input.day ? recordedCalendar(input) : refresh.promise,
    );
    const view = renderAt(
      "/users/7?role=assignee&state=closed&activity_year=2025&activity_day=2025-02-30",
      client,
    );
    try {
      await view.findByRole("button", { name: /^2025-03-04\b/ });
      await waitFor(() => {
        expect(view.router.state.location.pathname).toBe("/users/alice");
        expect(view.router.state.location.search).toEqual({
          role: "assignee",
          state: "closed",
          activity_year: 2025,
          activity_day: "2025-02-30",
          activity_invalid: true,
        });
        expect(notify).toHaveBeenCalledExactlyOnceWith(
          "Invalid activity date was reset.",
        );
      });
      expect(userSearchSchema(view.router.state.location.search)).toEqual({
        role: "assignee",
        state: "closed",
        activity_year: 2025,
        activity_invalid: true,
      });
      expect(view.router.history.canGoBack()).toBe(false);
      fireEvent.click(view.getByRole("button", { name: /^2025-03-04\b/ }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual(search),
      );
      await act(async () => refresh.resolve(calendar));
      await view.findByText("No active cards on 2025-03-04.");
      await settle();
      expect(view.router.state.location.search).toEqual(search);
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "Invalid activity date was reset.",
      );
      expect(
        view
          .getByRole("tab", { name: "Assigned" })
          .getAttribute("aria-selected"),
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
