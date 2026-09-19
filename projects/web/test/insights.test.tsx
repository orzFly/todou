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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { BurnResponse, Flow } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insightsKeys } from "../src/api/insights.ts";
import { api } from "../src/api/queries.ts";
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

function renderPage(
  entry = "/projects/x/insights?range=custom&from=2026-09-17&to=2026-09-18&tz=UTC",
) {
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
  });
  const testRouter = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([project.addChildren([insights])]),
    ]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const client = testQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
  return { ...view, router: testRouter, client };
}

afterEach(() => vi.restoreAllMocks());

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

  it("shows the Insights shape while loading and retries a cold read failure", async () => {
    vi.spyOn(api, "getInsightsSettings").mockResolvedValue(settings);
    const request = vi
      .spyOn(api, "getInsightsBurn")
      .mockReturnValue(new Promise<BurnResponse>(() => undefined));
    const loading = renderPage();
    expect(
      (await screen.findByTestId("page-skeleton")).getAttribute("data-kind"),
    ).toBe("insights");
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
