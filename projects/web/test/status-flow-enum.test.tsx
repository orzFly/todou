import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { BurnResponse, Measure, RoleEntry } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StatusFlowChart,
  statusFlowBucketRead,
} from "../src/components/insights/status-flow-chart.tsx";

const exact = (value: number): Measure => ({ value, known: value, unknown: 0 });

function response(): BurnResponse {
  return {
    as_of: "2026-09-02T00:00:00Z",
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-02T00:00:00Z",
    requested_grain: "1d",
    resolved_grain: "1d",
    timezone: "UTC",
    settings_version: "version-one",
    cohort: { mode: "current", count: 110 },
    history_coverage: {
      project_created_at: "2026-08-01T00:00:00Z",
      mode: "current_cohort",
      has_unknown: false,
      reasons: [],
    },
    statuses: [
      {
        status_id: 1,
        name: "Review",
        category: "open",
        role: "completed",
        color: "#2563eb",
        position: 1,
      },
      {
        status_id: 2,
        name: "Queued",
        category: "open",
        role: "excluded",
        color: "#7c3aed",
        position: 2,
      },
      {
        status_id: 3,
        name: "Done",
        category: "closed",
        role: "remaining",
        color: "#16a34a",
        position: 3,
      },
    ],
    opening: null,
    buckets: [
      {
        start: "2026-09-01T00:00:00Z",
        end: "2026-09-02T00:00:00Z",
        partial: false,
        current: false,
        quality: "exact",
        reasons: [],
        stock: {
          remaining: exact(100),
          scope: exact(107),
          open_total: exact(10),
          unknown_cards: 0,
          by_status: [
            { status_id: 1, count: 7 },
            { status_id: 2, count: 3 },
            { status_id: 3, count: 100 },
          ],
        },
        flow: {
          completed: exact(0),
          completed_cards: exact(0),
          reopened: exact(0),
          created_remaining: exact(0),
          created_completed: exact(0),
          moved_in_remaining: exact(0),
          moved_in_completed: exact(0),
          restored_remaining: exact(0),
          restored_completed: exact(0),
          reintroduced_remaining: exact(0),
          reintroduced_completed: exact(0),
          excluded_remaining: exact(0),
          excluded_completed: exact(0),
          deleted_remaining: exact(0),
          deleted_completed: exact(0),
          scope_added: exact(0),
          scope_removed: exact(0),
          open_entered: exact(0),
          open_exited: exact(0),
          category_closed: exact(0),
          category_reopened: exact(0),
          created_open: exact(0),
          moved_in_open: exact(0),
          restored_open: exact(0),
          deleted_open: exact(0),
          closed_by_status: [],
        },
      },
    ],
  };
}

function addFutureStatus(data: BurnResponse, category: string) {
  // Inject future wire data at the consumer boundary without widening schemas.
  data.statuses.push({
    status_id: 4,
    name: "Future status",
    category: category as RoleEntry["category"],
    role: "remaining",
    color: "#ca8a04",
    position: 0,
  });
  data.buckets[0]!.stock!.by_status.push({ status_id: 4, count: 1_000 });
}

const futureCategories = ["future_category", "constructor", "__proto__"];
const invalidCategories = [
  { label: "missing", fields: {} },
  { label: "undefined", fields: { category: undefined } },
  { label: "null", fields: { category: null } },
  { label: "empty string", fields: { category: "" } },
  { label: "number", fields: { category: 42 } },
  { label: "boolean", fields: { category: false } },
  { label: "object", fields: { category: {} } },
  { label: "array", fields: { category: [] } },
];

function invalidResponse(fields: object): BurnResponse {
  const data = response();
  const { category: _category, ...status } = data.statuses[1]!;
  data.statuses[1] = { ...status, ...fields } as RoleEntry;
  return data;
}

afterEach(cleanup);

describe("StatusFlowChart category wire values", () => {
  it.each(futureCategories)(
    "excludes %s from Open series, scale, legend and tooltip",
    (category) => {
      const data = response();
      const props = { data, selectedIndex: 0, onSelect: vi.fn() };
      const view = render(<StatusFlowChart {...props} />);
      const series = () => [
        ...view.container.querySelectorAll('[data-series="open-stock"]'),
      ];
      const knownPaths = series().map((path) => path.getAttribute("d"));
      const knownAxis =
        view.container.querySelector('[data-axis="Open"]')!.outerHTML;
      expect(knownPaths).toHaveLength(2);
      for (const path of knownPaths) expect(path).toMatch(/^M.+ Z$/);

      addFutureStatus(data, category);
      view.rerender(<StatusFlowChart {...props} />);
      expect(
        series().map((path) => path.getAttribute("data-status-id")),
      ).toEqual(["1", "2"]);
      expect(series().map((path) => path.getAttribute("d"))).toEqual(
        knownPaths,
      );
      expect(
        view.container.querySelector('[data-axis="Open"]')!.outerHTML,
      ).toBe(knownAxis);
      expect(
        within(view.getByRole("list", { name: "Status flow chart legend" }))
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual(["Review", "Queued"]);

      fireEvent.focus(
        view.getByRole("group", { name: "Status flow chart selection" }),
      );
      expect(view.getByRole("tooltip").lastElementChild?.textContent).toBe(
        "Review: 7 · Queued: 3",
      );
    },
  );

  it("renders no Open series or tooltip counts when only future and closed categories exist", () => {
    const data = response();
    addFutureStatus(data, "future_category");
    data.statuses = data.statuses.filter((status) => status.status_id >= 3);
    const view = render(
      <StatusFlowChart data={data} selectedIndex={0} onSelect={vi.fn()} />,
    );
    expect(
      view.container.querySelector('[data-series="open-stock"]'),
    ).toBeNull();
    expect(
      within(
        view.getByRole("list", { name: "Status flow chart legend" }),
      ).queryAllByRole("listitem"),
    ).toHaveLength(0);
    fireEvent.focus(
      view.getByRole("group", { name: "Status flow chart selection" }),
    );
    expect(view.getByRole("tooltip").lastElementChild?.textContent).toBe("");
  });

  it.each(invalidCategories)(
    "rejects $label category during rendering",
    ({ fields }) => {
      expect(() =>
        render(
          <StatusFlowChart
            data={invalidResponse(fields)}
            selectedIndex={0}
            onSelect={vi.fn()}
          />,
        ),
      ).toThrow(new TypeError("status category must be a non-empty string"));
    },
  );
});

describe("statusFlowBucketRead category wire values", () => {
  it("reads known open counts regardless of burn role and excludes closed counts", () => {
    const data = response();
    expect(statusFlowBucketRead(data.buckets[0]!, data.statuses)).toBe(
      "Review: 7 · Queued: 3",
    );
  });

  it.each(futureCategories)(
    "does not describe %s as Open stock",
    (category) => {
      const data = response();
      addFutureStatus(data, category);
      // Pass the unfiltered response: chart filtering must not hide a reader regression.
      expect(statusFlowBucketRead(data.buckets[0]!, data.statuses)).toBe(
        "Review: 7 · Queued: 3",
      );
      expect(
        statusFlowBucketRead(data.buckets[0]!, data.statuses.slice(2)),
      ).toBe("");
    },
  );

  it.each(invalidCategories)(
    "rejects $label category when reading a bucket",
    ({ fields }) => {
      const data = invalidResponse(fields);
      expect(() =>
        statusFlowBucketRead(data.buckets[0]!, data.statuses),
      ).toThrow(new TypeError("status category must be a non-empty string"));
    },
  );
});
