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
  const search = resolveInsightsSearch({ tz: "UTC" }, context);

  it("uses accessible native range, grain and timezone controls", () => {
    const change = vi.fn();
    render(
      <InsightsControls search={search} context={context} onChange={change} />,
    );
    fireEvent.change(screen.getByLabelText("Range"), {
      target: { value: "24h" },
    });
    expect(change).toHaveBeenLastCalledWith({
      range: "24h",
      grain: "auto",
      tz: "UTC",
    });
    fireEvent.change(screen.getByLabelText("Grain"), {
      target: { value: "6h" },
    });
    expect(change).toHaveBeenLastCalledWith({ ...search, grain: "6h" });
    expect(screen.getByLabelText("Timezone").tagName).toBe("SELECT");
  });

  it("seeds Custom with calendar dates and inclusive end", () => {
    const change = vi.fn();
    render(
      <InsightsControls search={search} context={context} onChange={change} />,
    );
    fireEvent.change(screen.getByLabelText("Range"), {
      target: { value: "custom" },
    });
    expect(change).toHaveBeenCalledWith({
      ...search,
      range: "custom",
      from: "2026-08-20",
      to: "2026-09-18",
    });
  });

  it("validates custom dates before applying the shared request", () => {
    const change = vi.fn();
    const custom = resolveInsightsSearch(
      { range: "custom", from: "2026-09-17", to: "2026-09-18", tz: "UTC" },
      context,
    );
    render(
      <InsightsControls search={custom} context={context} onChange={change} />,
    );
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-09-18" },
    });
    fireEvent.change(screen.getByLabelText("To (inclusive)"), {
      target: { value: "2026-09-17" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "valid dates in order",
    );
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("To (inclusive)"), {
      target: { value: "2026-09-18" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
    expect(change).toHaveBeenCalledWith({
      ...custom,
      from: "2026-09-18",
      to: "2026-09-18",
    });
    expect(insightsRequest(change.mock.calls[0][0], context)?.to).toBe(
      "2026-09-19",
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
    await screen.findByText(/Current cohort: 4 cards/);
    expect(settingsRequest).toHaveBeenCalledWith("x");
    const expected = {
      from: "2026-09-17",
      to: "2026-09-19",
      tz: "UTC",
      grain: "auto" as const,
    };
    expect(request).toHaveBeenCalledWith("x", expected);
    expect(
      view.client.getQueryData(insightsKeys.burnRequest("x", expected, "v1")),
    ).toEqual(data);
    fireEvent.change(screen.getByLabelText("Grain"), {
      target: { value: "6h" },
    });
    await waitFor(() =>
      expect(view.router.state.location.search.grain).toBe("6h"),
    );
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith("x", {
        ...expected,
        grain: "6h",
      }),
    );
    expect(screen.queryByText(/role settings/i)).toBeNull();
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
    await screen.findByText(/Current cohort: 4 cards/);
    failed.unmount();
    failed.client.clear();
  });

  it("shares selection between both charts, inspector and table, resetting on replacement", () => {
    const view = render(<InsightsResults data={data} />);
    const inspector = screen.getByRole("region", { name: "Bucket inspector" });
    const table = screen.getByRole("table", { name: "Insights buckets" });
    fireEvent.click(
      within(table).getByRole("button", { name: /Select bucket 1:/ }),
    );
    expect(
      [...view.container.querySelectorAll("svg[data-selected-bucket]")].map(
        (svg) => svg.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["0", "0"]);
    expect(inspector.textContent).toContain(data.buckets[0].start);
    fireEvent.keyDown(
      screen.getByRole("group", { name: "Burn chart bucket selection" }),
      { key: "End" },
    );
    expect(
      within(table)
        .getByRole("button", { name: /Select bucket 2:/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    view.rerender(
      <InsightsResults data={{ ...data, buckets: data.buckets.slice(0, 1) }} />,
    );
    expect(
      [...view.container.querySelectorAll("svg[data-selected-bucket]")].map(
        (svg) => svg.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["0", "0"]);
  });

  it("explains current-cohort coverage and handles empty ranges", () => {
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
    expect(
      screen.getByText(/Historical membership outside this cohort/),
    ).toBeTruthy();
    expect(screen.getByText(/Gaps are not zero/).textContent).toContain(
      "broken transition chain",
    );
    expect(screen.getByText("No buckets in this range.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
