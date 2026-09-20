import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ActivityCalendarQuery,
  ActivityCalendarResponse,
  type ActivityDay,
  BurnResponse,
  Flow,
  type Me,
  type Project,
} from "@todou/shared";
import * as sonner from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectActivityCalendarQuery } from "../src/api/activity-calendar.ts";
import { insightsKeys } from "../src/api/insights.ts";
import { api, meQuery, projectQuery } from "../src/api/queries.ts";
import {
  insightsRequest,
  parseInsightsSearch,
  resolveInsightsSearch,
} from "../src/lib/insights-search.ts";
import {
  InsightsControls,
  InsightsPage,
  InsightsResults,
} from "../src/pages/insights.tsx";
import { router } from "../src/router.tsx";
import { testQueryClient } from "./render.tsx";

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

const known = (value: number) => ({ value, known: value, unknown: 0 });
const flow = Flow.parse(
  Object.fromEntries(
    Object.keys(Flow.shape).map((key) => [
      key,
      key === "closed_by_status" ? [] : known(key === "completed" ? 3 : 0),
    ]),
  ),
);
const data = BurnResponse.parse({
  as_of: "2026-09-18T12:00:00Z",
  from: "2026-09-17T00:00:00Z",
  to: "2026-09-19T00:00:00Z",
  requested_grain: "auto",
  resolved_grain: "1d",
  timezone: "UTC",
  settings_version: "v1",
  cohort: { mode: "current", count: 4 },
  history_coverage: {
    project_created_at: "2026-01-01T00:00:00Z",
    mode: "current_cohort",
    has_unknown: false,
    reasons: [],
  },
  statuses: [
    {
      status_id: 1,
      name: "Todo",
      category: "open",
      color: "#123456",
      position: 0,
      role: "remaining",
    },
  ],
  opening: null,
  buckets: [0, 1].map((index) => ({
    start: `2026-09-${17 + index}T00:00:00Z`,
    end: `2026-09-${18 + index}T00:00:00Z`,
    current: index === 1,
    partial: index === 1,
    quality: "exact",
    reasons: [],
    stock: {
      remaining: known(4),
      scope: known(4),
      open_total: known(4),
      by_status: [{ status_id: 1, count: 4 }],
      unknown_cards: 0,
    },
    flow,
  })),
});
const settings = {
  version: "v1",
  source: "default" as const,
  roles: data.statuses,
};

const viewer: Me = {
  id: 7,
  login: "user",
  display_name: "User",
  kind: "human",
  avatar_url: null,
  owner: null,
  email: null,
  is_instance_admin: false,
  created_at: "2025-01-01T00:00:00Z",
};
const canonicalProject: Project = {
  id: 42,
  slug: "canonical-x",
  name: "Example project",
  description: "",
  created_at: "2025-09-17T00:00:00Z",
  viewer_role: "admin",
};
const cutoff = "2026-09-18T12:00:00Z";

function calendarSnapshot(
  query: ActivityCalendarQuery,
  recorded = false,
): ActivityCalendarResponse {
  const days: ActivityDay[] = [];
  const date = new Date(`${query.from}T00:00:00Z`);
  while (date.toISOString().slice(0, 10) < query.to) {
    const day = date.toISOString().slice(0, 10);
    days.push(
      day > "2026-09-18"
        ? { date: day, state: "future", count: null }
        : recorded && day >= "2025-09-17"
          ? {
              date: day,
              state: "recorded",
              count: day.endsWith("-09-17") || day.endsWith("-09-18") ? 1 : 0,
            }
          : { date: day, state: "not_applicable", count: null },
    );
    date.setUTCDate(date.getUTCDate() + 1);
  }
  const selected = days.find((day) => day.date === query.day);
  return ActivityCalendarResponse.parse({
    from: query.from,
    to: query.to,
    timezone: query.tz,
    cutoff,
    read_started_at: cutoff,
    read_finished_at: cutoff,
    days,
    selection:
      selected?.state === "recorded"
        ? {
            date: selected.date,
            total: selected.count,
            items: selected.count
              ? [
                  {
                    project: { ...canonicalProject, issue_prefix: null },
                    issue_id: 123,
                    number: 3,
                    title: `Activity on ${selected.date}`,
                    status: {
                      id: 1,
                      name: "Todo",
                      category: "open",
                      color: "#123456",
                      position: 0,
                      is_default: true,
                    },
                    url: "/projects/canonical-x/issues/3",
                    last_active_at: `${selected.date}T01:00:00Z`,
                  },
                ]
              : [],
            next_cursor: null,
            has_more: false,
          }
        : null,
  });
}

const recordedCalendar = (query: ActivityCalendarQuery) =>
  calendarSnapshot(query, true);

function renderPage(
  entry = "/projects/x/insights?range=custom&from=2026-09-17&to=2026-09-18&tz=UTC",
  {
    seedIdentities = true,
    calendar = calendarSnapshot,
  }: {
    seedIdentities?: boolean;
    calendar?: (
      query: ActivityCalendarQuery,
    ) => ActivityCalendarResponse | Promise<ActivityCalendarResponse>;
  } = {},
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(cutoff));
  const requests: URL[] = [];
  const calendarRequest = vi.fn(calendar);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    requests.push(url);
    if (url.pathname === "/api/me") return Response.json(viewer);
    if (url.pathname === "/api/projects/x") {
      return Response.json(canonicalProject);
    }
    if (url.pathname === "/api/projects/canonical-x/insights/activity") {
      return Response.json(
        await calendarRequest(
          ActivityCalendarQuery.parse(Object.fromEntries(url.searchParams)),
        ),
      );
    }
    throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
  });
  const root = createRootRoute();
  const authed = createRoute({ getParentRoute: () => root, id: "authed" });
  const project = createRoute({
    getParentRoute: () => authed,
    path: "/projects/$slug",
  });
  const insights = createRoute({
    getParentRoute: () => project,
    path: "insights",
    component: InsightsPage,
    validateSearch: parseInsightsSearch,
    search: router.routesById["/authed/projects/$slug/insights"].options.search,
  });
  const testRouter = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([project.addChildren([insights])]),
    ]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const client = testQueryClient();
  if (seedIdentities) {
    client.setQueryData(meQuery.queryKey, viewer);
    client.setQueryData(projectQuery("x").queryKey, canonicalProject);
  }
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return { ...view, router: testRouter, client, requests, calendarRequest };
}

afterEach(() => {
  vi.mocked(sonner.toast).mockClear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Insights route", () => {
  it("uses the one shared URL parser and declares the Insights loading shape", () => {
    const route = router.routesById["/authed/projects/$slug/insights"];
    expect(route.options.validateSearch).toBe(parseInsightsSearch);
    expect(route.options.staticData?.pageSkeleton).toBe("insights");
  });

  it("keeps the page/charts outside static router imports", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/router.tsx"),
      "utf8",
    );
    expect(source).toContain('() => import("@/pages/insights.tsx")');
    expect(source).toMatch(
      /const projectInsightsRoute = createRoute\(\{[^}]*component:\s*lazyRouteComponent\(\s*\(\) => import\("@\/pages\/insights\.tsx"\),\s*"InsightsPage"/,
    );
    expect(source).not.toMatch(
      /import\s[^;]*from\s["'][^"']*(?:pages\/insights|components\/insights)/,
    );
  });
});

describe("Insights controls", () => {
  const context = { now: new Date("2026-09-18T01:00:00Z"), timezone: "UTC" };
  const search = resolveInsightsSearch({}, context);

  it("keeps all five ranges and six grains visible as independent pressed buttons", () => {
    const change = vi.fn();
    render(
      <InsightsControls search={search} context={context} onChange={change} />,
    );
    const ranges = screen.getByRole("group", { name: "Time range" });
    const grains = screen.getByRole("group", { name: "Granularity" });
    expect(
      within(ranges)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["24h", "7d", "30d", "90d", "Custom"]);
    expect(
      within(grains)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Auto", "1h", "6h", "12h", "1d", "1w"]);
    expect(
      within(ranges)
        .getByRole("button", { name: "30d" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(grains)
        .getByRole("button", { name: "Auto" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(ranges).getByRole("button", { name: "24h" }));
    expect(change).toHaveBeenLastCalledWith({
      range: "24h",
      grain: "auto",
    });
    fireEvent.click(within(grains).getByRole("button", { name: "6h" }));
    expect(change).toHaveBeenLastCalledWith({
      range: "30d",
      from: undefined,
      to: undefined,
      grain: "6h",
    });
    expect(screen.queryByLabelText("时区")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Time range" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Granularity" })).toBeNull();
  });

  it("seeds Custom with calendar dates and inclusive end", () => {
    const change = vi.fn();
    render(
      <InsightsControls search={search} context={context} onChange={change} />,
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "Time range" })).getByRole(
        "button",
        {
          name: "Custom",
        },
      ),
    );
    expect(change).toHaveBeenCalledWith({
      range: "custom",
      grain: "auto",
      from: "2026-08-20",
      to: "2026-09-18",
    });
  });

  it("validates custom dates before applying the shared request", () => {
    const change = vi.fn();
    const custom = resolveInsightsSearch(
      { range: "custom", from: "2026-09-17", to: "2026-09-18" },
      context,
    );
    render(
      <InsightsControls search={custom} context={context} onChange={change} />,
    );
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-09-18" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-09-17" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "valid dates in order",
    );
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-09-18" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(change).toHaveBeenCalledWith({
      range: "custom",
      grain: "auto",
      from: "2026-09-18",
      to: "2026-09-18",
    });
    expect(insightsRequest(change.mock.calls[0][0], context)?.to).toBe(
      "2026-09-19",
    );
  });

  it("disables unavailable grains without explanatory copy and enables shorter ranges", () => {
    const change = vi.fn();
    const view = render(
      <InsightsControls search={search} context={context} onChange={change} />,
    );
    const grain = screen.getByRole("group", { name: "Granularity" });
    const unavailable = within(grain).getByRole("button", { name: "1h" });
    expect(unavailable).toHaveProperty("disabled", true);
    expect(unavailable.getAttribute("title")).toBeNull();
    expect(unavailable.getAttribute("aria-label")).toBeNull();
    fireEvent.click(unavailable);
    expect(change).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toMatch(/bucket|400|Auto\s*→/i);
    expect(screen.queryByRole("combobox")).toBeNull();
    view.rerender(
      <InsightsControls
        search={{ ...search, range: "7d" }}
        context={context}
        onChange={change}
      />,
    );
    expect(within(grain).getByRole("button", { name: "1h" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("Insights page", () => {
  it("mounts the real calendar without rewriting a valid old URL with no activity dates", async () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...options,
      timeZone: "Asia/Tokyo",
    });
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const entry =
      "/projects/x/insights?range=custom&from=2026-09-17&to=2026-09-18&grain=6h&tz=America%2FNew_York";
    const view = renderPage(entry, { seedIdentities: false });
    await screen.findByText("No available dates in this range.");
    await screen.findByRole("heading", { name: "Burn chart" });
    expect(view.router.state.location.href).toBe(entry);
    expect(view.router.state.location.search).not.toHaveProperty(
      "activity_year",
    );
    expect(view.router.state.location.search).not.toHaveProperty(
      "activity_day",
    );
    expect(view.requests.map((url) => url.pathname)).toEqual(
      expect.arrayContaining(["/api/me", "/api/projects/x"]),
    );
    expect(view.client.getQueryData(meQuery.queryKey)).toEqual(viewer);
    expect(view.client.getQueryData(projectQuery("x").queryKey)).toEqual(
      canonicalProject,
    );
    expect(view.calendarRequest).toHaveBeenCalledExactlyOnceWith({
      from: "2025-09-22",
      to: "2026-09-19",
      tz: "Asia/Tokyo",
      limit: 50,
    });
    const query = {
      viewerId: viewer.id,
      projectId: canonicalProject.id,
      slug: canonicalProject.slug,
      from: "2025-09-22",
      to: "2026-09-19",
      tz: "Asia/Tokyo",
    };
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ["activity-project"] })
        .map((cached) => cached.queryKey),
    ).toEqual([
      [
        "activity-project",
        "canonical-x",
        {
          viewerId: 7,
          projectId: 42,
          from: "2025-09-22",
          to: "2026-09-19",
          day: undefined,
          tz: "Asia/Tokyo",
          limit: 50,
          after: undefined,
        },
      ],
    ]);
    const cached = view.client.getQueryData(
      projectActivityCalendarQuery(query).queryKey,
    );
    expect(cached).toEqual(
      calendarSnapshot({
        from: "2025-09-22",
        to: "2026-09-19",
        tz: "Asia/Tokyo",
        limit: 50,
      }),
    );
    const dates = screen.getByRole("group", {
      name: "Activity dates 2025-09-22 to 2026-09-18",
    });
    // The rolling window is 52 columns ending at today, not a calendar year.
    expect(within(dates).getAllByRole("button")).toHaveLength(362);
    expect(
      within(dates).getByRole("button", { name: /2026-09-17: Not applicable/ }),
    ).toHaveProperty("disabled", true);
    // The window stops at today, so no future cell is drawn at all.
    expect(within(dates).queryByRole("button", { name: /Future date/ })).toBe(
      null,
    );
    expect(
      within(dates).getAllByRole("button").at(-1)?.getAttribute("data-date"),
    ).toBe("2026-09-18");
    expect(
      screen.queryByRole("region", { name: "Selected day activity" }),
    ).toBeNull();
    expect(burn).toHaveBeenCalledExactlyOnceWith("x", {
      from: "2026-09-17",
      to: "2026-09-19",
      grain: "6h",
      tz: "Asia/Tokyo",
    });
    view.unmount();
    view.client.clear();
  });

  it("preserves the selected activity year and day through grain, preset and custom graph changes", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(
      "/projects/x/insights?range=custom&from=2026-09-17&to=2026-09-18&activity_day=2026-09-17&tz=UTC",
      { calendar: recordedCalendar },
    );
    await screen.findByText("Activity on 2026-09-17");
    await screen.findByRole("heading", { name: "Burn chart" });
    const activity = { activity_day: "2026-09-17" };
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    expect(
      screen
        .getByRole("button", { name: /2026-09-17: 1 active card/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(view.calendarRequest.mock.calls.map(([query]) => query.day)).toEqual(
      [undefined, "2026-09-17"],
    );
    fireEvent.click(screen.getByRole("button", { name: "6h" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...activity,
        range: "custom",
        from: "2026-09-17",
        to: "2026-09-18",
        grain: "6h",
      }),
    );
    await waitFor(() =>
      expect(burn).toHaveBeenLastCalledWith("x", {
        from: "2026-09-17",
        to: "2026-09-19",
        grain: "6h",
        tz,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...activity,
        range: "7d",
        grain: "6h",
      }),
    );
    const presetSearch = new URLSearchParams(
      view.router.state.location.searchStr,
    );
    expect(presetSearch.has("from")).toBe(false);
    expect(presetSearch.has("to")).toBe(false);
    expect(presetSearch.has("tz")).toBe(false);
    await waitFor(() =>
      expect(burn).toHaveBeenLastCalledWith(
        "x",
        insightsRequest(
          { range: "7d", grain: "6h" },
          {
            now: new Date(cutoff),
            timezone: tz,
          },
        ),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    await screen.findByLabelText("Start date");
    expect(view.router.state.location.search).toMatchObject({
      ...activity,
      range: "custom",
      grain: "6h",
    });
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-09-15" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-09-16" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...activity,
        range: "custom",
        from: "2026-09-15",
        to: "2026-09-16",
        grain: "6h",
      }),
    );
    await waitFor(() =>
      expect(burn).toHaveBeenLastCalledWith("x", {
        from: "2026-09-15",
        to: "2026-09-17",
        grain: "6h",
        tz,
      }),
    );
    expect(screen.getByText("Activity on 2026-09-17")).toBeTruthy();
    expect(view.calendarRequest).toHaveBeenCalledTimes(2);
    expect(
      view.client.getQueryData(
        projectActivityCalendarQuery({
          viewerId: viewer.id,
          projectId: canonicalProject.id,
          slug: canonicalProject.slug,
          from: "2025-09-22",
          to: "2026-09-19",
          day: "2026-09-17",
          tz,
        }).queryKey,
      ),
    ).toEqual(
      recordedCalendar({
        from: "2025-09-22",
        to: "2026-09-19",
        day: "2026-09-17",
        tz,
        limit: 50,
      }),
    );
    view.unmount();
    view.client.clear();
  });

  it.each(["partially unavailable", "all unavailable"] as const)(
    "resets a server-rejected day with one notice when project dates are %s",
    async (availability) => {
      vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
      vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
      const view = renderPage(
        "/projects/x/insights?range=custom&from=2026-09-15&to=2026-09-18&grain=6h&activity_day=2025-01-01",
        {
          calendar: (query) =>
            calendarSnapshot(query, availability === "partially unavailable"),
        },
      );
      if (availability === "all unavailable") {
        await screen.findByText("No available dates in this range.");
      } else {
        // The rejected day is cleared rather than swapped for another, and
        // with nothing selected there is no card list to render at all.
        await screen.findByRole("heading", { name: "Burn chart" });
        await waitFor(() =>
          expect(
            screen.queryByRole("region", { name: "Selected day activity" }),
          ).toBeNull(),
        );
      }
      await waitFor(() => {
        expect(view.router.state.location.search).toEqual({
          range: "custom",
          from: "2026-09-15",
          to: "2026-09-18",
          grain: "6h",
        });
        expect(sonner.toast).toHaveBeenCalledExactlyOnceWith(
          "Invalid activity date was reset.",
        );
      });
      expect(view.router.history.canGoBack()).toBe(false);
      expect(view.calendarRequest).not.toHaveBeenCalledWith(
        expect.objectContaining({ day: "2025-01-01" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "7d" }));
      await waitFor(() =>
        expect(view.router.state.location.search.range).toBe("7d"),
      );
      expect(sonner.toast).toHaveBeenCalledTimes(1);
      view.unmount();
      view.client.clear();
    },
  );

  it("leaves an empty project year with no requested day quiet", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage("/projects/x/insights?range=7d&grain=6h");
    await screen.findByText("No available dates in this range.");
    expect(view.router.state.location.search).toEqual({
      range: "7d",
      grain: "6h",
    });
    expect(sonner.toast).not.toHaveBeenCalled();
    expect(view.router.history.canGoBack()).toBe(false);
    view.unmount();
    view.client.clear();
  });

  it.each(["click", "Enter"] as const)(
    "drops legacy URL timezone on calendar %s while preserving graph filters",
    async (action) => {
      const options = Intl.DateTimeFormat().resolvedOptions();
      vi.spyOn(
        Intl.DateTimeFormat.prototype,
        "resolvedOptions",
      ).mockReturnValue({
        ...options,
        timeZone: "Asia/Tokyo",
      });
      vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
      const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
      const view = renderPage(
        "/projects/x/insights?range=custom&from=2026-09-15&to=2026-09-18&grain=6h&activity_day=2026-09-17&tz=Pacific%2FHonolulu",
        { calendar: recordedCalendar },
      );
      await screen.findByText("Activity on 2026-09-17");
      expect(
        new URLSearchParams(view.router.state.location.searchStr).get("tz"),
      ).toBe("Pacific/Honolulu");
      const date = screen.getByRole("button", {
        name: /2026-09-18: 1 active card/,
      });
      if (action === "Enter") fireEvent.keyDown(date, { key: "Enter" });
      else fireEvent.click(date);
      await screen.findByText("Activity on 2026-09-18");
      expect(
        new URLSearchParams(view.router.state.location.searchStr).has("tz"),
      ).toBe(false);
      expect(view.router.state.location.search).toEqual({
        range: "custom",
        from: "2026-09-15",
        to: "2026-09-18",
        grain: "6h",
        activity_day: "2026-09-18",
      });
      expect(view.calendarRequest).toHaveBeenLastCalledWith({
        from: "2025-09-22",
        to: "2026-09-19",
        day: "2026-09-18",
        tz: "Asia/Tokyo",
        limit: 50,
      });
      expect(burn).toHaveBeenCalledExactlyOnceWith("x", {
        from: "2026-09-15",
        to: "2026-09-19",
        grain: "6h",
        tz: "Asia/Tokyo",
      });
      view.unmount();
      view.client.clear();
    },
  );

  it("retains custom graph filters through activity selections and back/forward", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(
      "/projects/x/insights?range=custom&from=2026-09-15&to=2026-09-18&grain=6h&activity_day=2026-09-17",
      { calendar: recordedCalendar },
    );
    await screen.findByText("Activity on 2026-09-17");
    await screen.findByRole("heading", { name: "Burn chart" });
    const graph = {
      range: "custom",
      from: "2026-09-15",
      to: "2026-09-18",
      grain: "6h",
    };
    fireEvent.click(
      screen.getByRole("button", { name: /2026-09-18: 1 active card/ }),
    );
    await screen.findByText("Activity on 2026-09-18");
    expect(view.router.state.location.search).toEqual({
      ...graph,
      activity_day: "2026-09-18",
    });
    fireEvent.click(
      screen.getByRole("button", { name: /2026-09-17: 1 active card/ }),
    );
    await screen.findByText("Activity on 2026-09-17");
    expect(view.router.state.location.search).toEqual({
      ...graph,
      activity_day: "2026-09-17",
    });
    await act(async () => {
      view.router.history.back();
    });
    await screen.findByText("Activity on 2026-09-18");
    expect(view.router.state.location.search).toEqual({
      ...graph,
      activity_day: "2026-09-18",
    });
    await act(async () => {
      view.router.history.forward();
    });
    await screen.findByText("Activity on 2026-09-17");
    expect(view.router.state.location.search).toEqual({
      ...graph,
      activity_day: "2026-09-17",
    });
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    expect(burn).toHaveBeenCalledExactlyOnceWith("x", {
      from: "2026-09-15",
      to: "2026-09-19",
      grain: "6h",
      tz,
    });
    expect(screen.getByRole("heading", { name: "Burn chart" })).toBeTruthy();
    view.unmount();
    view.client.clear();
  });

  it("ignores a raw URL boolean activity marker and strips it from graph changes and links", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(
      "/projects/x/insights?range=7d&grain=6h&activity_day=2026-09-17&activity_invalid=true",
      { calendar: recordedCalendar },
    );
    await screen.findByText("Activity on 2026-09-17");
    expect(view.router.options.parseSearch!("?activity_invalid=true")).toEqual({
      activity_invalid: true,
    });
    expect(sonner.toast).not.toHaveBeenCalled();
    const linked = view.router.buildLocation({
      to: "/projects/$slug/insights",
      params: { slug: "x" },
      search: true,
      _includeValidateSearch: true,
    });
    expect(new URLSearchParams(linked.searchStr).has("activity_invalid")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "12h" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        range: "7d",
        grain: "12h",
        activity_day: "2026-09-17",
      }),
    );
    expect(sonner.toast).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("normalizes malformed activity immediately with no recorded fallback and reopens quietly", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(
      "/projects/x/insights?range=custom&from=2026-09-15&to=2026-09-18&grain=6h&activity_day=2025-02-30",
    );
    await screen.findByText("No available dates in this range.");
    const normalized = {
      range: "custom",
      from: "2026-09-15",
      to: "2026-09-18",
      grain: "6h",
    };
    await waitFor(() => {
      expect(view.router.state.location.search).toEqual(normalized);
      expect(sonner.toast).toHaveBeenCalledExactlyOnceWith(
        "Invalid activity date was reset.",
      );
    });
    expect(view.router.history.canGoBack()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "12h" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        ...normalized,
        grain: "12h",
      }),
    );
    const shared = view.router.state.location.href;
    expect(shared).not.toContain("activity_invalid");
    expect(shared).not.toContain("2025-02-30");
    view.unmount();
    view.client.clear();
    vi.mocked(sonner.toast).mockClear();
    const reopened = renderPage(shared);
    await screen.findByText("No available dates in this range.");
    expect(reopened.router.state.location.search).toEqual({
      ...normalized,
      grain: "12h",
    });
    expect(sonner.toast).not.toHaveBeenCalled();
    reopened.unmount();
    reopened.client.clear();
  });

  it.each([
    "activity_day=2026-02-30",
    "activity_day=2025-09-17",
    "activity_day=2027-09-17",
  ])(
    "keeps graph fetching and filtering independent of invalid activity: %s",
    async (activity) => {
      const settingsRequest = vi
        .spyOn(api, "getInsightsSettings")
        .mockResolvedValue(settings);
      const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
      const view = renderPage(
        `/projects/x/insights?range=custom&from=2026-09-15&to=2026-09-18&grain=6h&${activity}`,
        { calendar: recordedCalendar },
      );
      await screen.findByRole("heading", { name: "Burn chart" });
      // An invalid day is cleared, and nothing is chosen in its place, so the
      // card list stays away while the graph carries on regardless.
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "Selected day activity" }),
        ).toBeNull(),
      );
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
      expect(settingsRequest).toHaveBeenCalledExactlyOnceWith("x");
      expect(burn).toHaveBeenCalledExactlyOnceWith("x", {
        from: "2026-09-15",
        to: "2026-09-19",
        grain: "6h",
        tz,
      });
      expect(
        screen.queryByText("Invalid URL filters were reset to safe defaults."),
      ).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        view.calendarRequest.mock.calls.map(([query]) => [
          query.from,
          query.day,
        ]),
        // One request, not two: with no day chosen for the reader there is no
        // follow-up fetch for that day's cards.
      ).toEqual([["2025-09-22", undefined]]);
      fireEvent.click(screen.getByRole("button", { name: "12h" }));
      await waitFor(() =>
        expect(view.router.state.location.search).toEqual({
          range: "custom",
          from: "2026-09-15",
          to: "2026-09-18",
          grain: "12h",
        }),
      );
      await waitFor(() =>
        expect(burn).toHaveBeenLastCalledWith("x", {
          from: "2026-09-15",
          to: "2026-09-19",
          grain: "12h",
          tz,
        }),
      );
      expect(
        screen.queryByRole("region", { name: "Selected day activity" }),
      ).toBeNull();
      view.unmount();
      view.client.clear();
    },
  );

  it("allows activity selection and fetching while an invalid graph range remains invalid", async () => {
    const settingsRequest = vi
      .spyOn(api, "getInsightsSettings")
      .mockResolvedValue(settings);
    const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(
      "/projects/x/insights?range=custom&from=2026-09-18&to=2026-09-17&grain=6h&activity_day=2026-09-17",
      { calendar: recordedCalendar },
    );
    await screen.findByText("Activity on 2026-09-17");
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a valid custom range",
    );
    fireEvent.click(
      screen.getByRole("button", { name: /2026-09-18: 1 active card/ }),
    );
    await screen.findByText("Activity on 2026-09-18");
    expect(view.router.state.location.search).toEqual({
      range: "custom",
      from: "2026-09-18",
      to: "2026-09-17",
      grain: "6h",
      activity_day: "2026-09-18",
    });
    expect(view.calendarRequest.mock.calls.map(([query]) => query.day)).toEqual(
      [undefined, "2026-09-17", "2026-09-18"],
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a valid custom range",
    );
    expect(settingsRequest).not.toHaveBeenCalled();
    expect(burn).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("keeps the charts mounted through range and grain changes", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage();
    const chart = await screen.findByRole("heading", { name: "Burn chart" });
    expect(
      document.querySelector('[data-testid="insights-results-skeleton"]'),
    ).toBeNull();

    // Every range and grain is its own query key. Without carried-over data the
    // charts fall back to the results skeleton on each change, and the reader
    // watches the whole section collapse and reflow to read a nearby window.
    // Node identity is the criterion: a skeleton in between unmounts this one.
    for (const button of ["90d", "7d", "12h", "1d"]) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(
        document.querySelector('[data-testid="insights-results-skeleton"]'),
      ).toBeNull();
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: button })
            .getAttribute("aria-pressed"),
        ).toBe("true"),
      );
      expect(
        document.querySelector('[data-testid="insights-results-skeleton"]'),
      ).toBeNull();
      expect(screen.getByRole("heading", { name: "Burn chart" })).toBe(chart);
    }
    view.unmount();
    view.client.clear();
  });

  it("keeps charts and graph filters working through calendar failure and retry", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const burn = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(undefined, {
      calendar: async () => {
        throw new Error("calendar unavailable");
      },
    });
    const activity = await screen.findByRole("region", { name: "Activity" });
    await within(activity).findByText(/calendar unavailable/);
    await screen.findByRole("heading", { name: "Burn chart" });
    expect(
      screen.getByRole("heading", { name: "Status flow chart" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "6h" }));
    await waitFor(() =>
      expect(burn).toHaveBeenLastCalledWith("x", {
        from: "2026-09-17",
        to: "2026-09-19",
        grain: "6h",
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      }),
    );
    expect(view.router.state.location.search).toEqual({
      range: "custom",
      from: "2026-09-17",
      to: "2026-09-18",
      grain: "6h",
    });
    view.calendarRequest.mockImplementation(calendarSnapshot);
    fireEvent.click(within(activity).getByRole("button", { name: "Retry" }));
    await screen.findByText("No available dates in this range.");
    expect(within(activity).queryByRole("alert")).toBeNull();
    expect(burn).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Burn chart" })).toBeTruthy();
    view.unmount();
    view.client.clear();
  });

  it("fetches settings first and uses a versioned burn key plus route search", async () => {
    const settingsRequest = vi
      .spyOn(api, "getInsightsSettings")
      .mockResolvedValue(settings);
    const request = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage();
    await screen.findByRole("heading", { name: "Burn chart" });
    expect(settingsRequest).toHaveBeenCalledWith("x");
    const expected = {
      from: "2026-09-17",
      to: "2026-09-19",
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      grain: "auto" as const,
    };
    expect(request).toHaveBeenCalledWith("x", expected);
    expect(
      view.client.getQueryData(insightsKeys.burnRequest("x", expected, "v1")),
    ).toEqual(data);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Granularity" })).getByRole(
        "button",
        { name: "6h" },
      ),
    );
    await waitFor(() =>
      expect(view.router.state.location.search.grain).toBe("6h"),
    );
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("x", {
        ...expected,
        grain: "6h",
      }),
    );
    expect(view.router.state.location.search).not.toHaveProperty("tz");
    expect(
      new URLSearchParams(view.router.state.location.searchStr).has("tz"),
    ).toBe(false);
    expect(screen.queryByText(/role settings/i)).toBeNull();
    view.unmount();
    view.client.clear();
  });

  it("uses the browser timezone despite legacy tz and omits tz after range changes", async () => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      ...options,
      timeZone: "Asia/Tokyo",
    });
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const request = vi.spyOn(api, "getInsightsBurn").mockResolvedValue({
      ...data,
      timezone: "Asia/Tokyo",
    });
    const view = renderPage();
    await screen.findByRole("heading", { name: "Burn chart" });
    expect(request).toHaveBeenCalledWith("x", {
      from: "2026-09-17",
      to: "2026-09-19",
      grain: "auto",
      tz: "Asia/Tokyo",
    });
    expect(screen.queryByLabelText("时区")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() =>
      expect(view.router.state.location.search.range).toBe("7d"),
    );
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        "x",
        expect.objectContaining({ tz: "Asia/Tokyo" }),
      ),
    );
    expect(
      new URLSearchParams(view.router.state.location.searchStr).has("tz"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    await screen.findByLabelText("Start date");
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-09-16" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-09-18" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply dates" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        range: "custom",
        from: "2026-09-16",
        to: "2026-09-18",
        grain: "auto",
      }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("x", {
        from: "2026-09-16",
        to: "2026-09-19",
        grain: "auto",
        tz: "Asia/Tokyo",
      }),
    );
    expect(
      new URLSearchParams(view.router.state.location.searchStr).has("tz"),
    ).toBe(false);
    view.unmount();
    view.client.clear();
  });

  it("does not fetch an invalid custom URL range", async () => {
    const settingsRequest = vi
      .spyOn(api, "getInsightsSettings")
      .mockResolvedValue(settings);
    const request = vi.spyOn(api, "getInsightsBurn").mockResolvedValue(data);
    const view = renderPage(
      "/projects/x/insights?range=custom&from=2026-09-18&to=2026-09-17&tz=UTC",
    );
    await screen.findByRole("alert");
    expect(settingsRequest).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    view.unmount();
    view.client.clear();
  });

  it("shows only chart placeholders while loading and retries a cold read failure", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const request = vi
      .spyOn(api, "getInsightsBurn")
      .mockReturnValue(new Promise<BurnResponse>(() => undefined));
    const loading = renderPage();
    expect(await screen.findByTestId("insights-results-skeleton")).toBeTruthy();
    expect(screen.queryByTestId("page-skeleton")).toBeNull();
    expect(screen.queryByTestId("insights-skeleton-controls")).toBeNull();
    expect(screen.getByRole("heading", { name: "Insights" })).toBeTruthy();
    loading.unmount();
    loading.client.clear();
    request
      .mockRejectedValueOnce(new Error("read unavailable"))
      .mockResolvedValueOnce(data);
    const failed = renderPage();
    await screen.findByText(/Could not load insights: read unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("heading", { name: "Burn chart" });
    failed.unmount();
    failed.client.clear();
  });

  it("shares selection between both charts and resets it on replacement", () => {
    const view = render(<InsightsResults data={data} />);
    expect(
      [...view.container.querySelectorAll("svg[data-selected-bucket]")].map(
        (svg) => svg.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["1", "1"]);
    fireEvent.keyDown(
      screen.getByRole("group", { name: /Burn chart.*selection/ }),
      { key: "Home" },
    );
    expect(
      [...view.container.querySelectorAll("svg[data-selected-bucket]")].map(
        (svg) => svg.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["0", "0"]);
    fireEvent.keyDown(
      screen.getByRole("group", { name: /Status flow chart.*selection/ }),
      { key: "End" },
    );
    expect(
      [...view.container.querySelectorAll("svg[data-selected-bucket]")].map(
        (svg) => svg.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["1", "1"]);
    view.rerender(
      <InsightsResults data={{ ...data, buckets: data.buckets.slice(0, 1) }} />,
    );
    expect(
      [...view.container.querySelectorAll("svg[data-selected-bucket]")].map(
        (svg) => svg.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["0", "0"]);
  });

  it("omits the inspector, table and historical explanations", () => {
    render(
      <InsightsResults
        data={{
          ...data,
          history_coverage: {
            ...data.history_coverage,
            has_unknown: true,
            reasons: ["broken_transition_chain"],
          },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Burn chart" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Status flow chart" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Bucket inspector" }),
    ).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.queryByText(/当前卡片集合|删除或移出卡片|搬入卡片|修改状态角色/),
    ).toBeNull();
    expect(
      screen.queryByText(
        /数据截至|Some history is unknown|Gaps are not zero|broken transition chain/,
      ),
    ).toBeNull();
  });

  it("handles empty ranges without technical terminology", () => {
    render(
      <InsightsResults
        data={{
          ...data,
          buckets: [],
          history_coverage: {
            ...data.history_coverage,
            has_unknown: true,
            reasons: ["broken_transition_chain"],
          },
        }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "No data in this range.",
    );
    expect(screen.queryByRole("heading", { name: "Burn chart" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps charts and a concise empty project state when there are no cards", () => {
    render(
      <InsightsResults
        data={{ ...data, cohort: { ...data.cohort, count: 0 } }}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "No cards in this project.",
    );
    expect(screen.getByRole("heading", { name: "Burn chart" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Status flow chart" }),
    ).toBeTruthy();
  });
});
