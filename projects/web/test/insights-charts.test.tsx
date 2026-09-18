import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type {
  Bucket,
  BurnResponse,
  Flow,
  Measure,
  StockSnapshot,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BucketInspector } from "../src/components/insights/bucket-inspector.tsx";
import { BucketTable } from "../src/components/insights/bucket-table.tsx";
import { BurnChart } from "../src/components/insights/burn-chart.tsx";
import { StatusFlowChart } from "../src/components/insights/status-flow-chart.tsx";

const exact = (value: number): Measure => ({ value, known: value, unknown: 0 });
const unknown = (known: number, count: number): Measure => ({
  value: null,
  known,
  unknown: count,
});

function flow(completed: number): Flow {
  return {
    completed: exact(completed),
    completed_cards: exact(3),
    reopened: exact(2),
    created_remaining: exact(4),
    created_completed: exact(1),
    moved_in_remaining: exact(5),
    moved_in_completed: exact(2),
    restored_remaining: exact(6),
    restored_completed: exact(3),
    reintroduced_remaining: exact(7),
    reintroduced_completed: exact(4),
    excluded_remaining: exact(8),
    excluded_completed: exact(5),
    deleted_remaining: exact(9),
    deleted_completed: exact(6),
    scope_added: exact(22),
    scope_removed: exact(11),
    open_entered: exact(12),
    open_exited: exact(13),
    category_closed: exact(11),
    category_reopened: exact(14),
    created_open: exact(15),
    moved_in_open: exact(16),
    restored_open: exact(17),
    deleted_open: exact(18),
    closed_by_status: [
      { status_id: 1, count: exact(99) },
      { status_id: 3, count: exact(2) },
      { status_id: 4, count: exact(4) },
      { status_id: 5, count: exact(5) },
    ],
  };
}

function stock(remaining: number): StockSnapshot {
  return {
    remaining: exact(remaining),
    scope: exact(30),
    open_total: exact(10),
    unknown_cards: 0,
    by_status: [
      { status_id: 1, count: 7 },
      { status_id: 2, count: 3 },
      { status_id: 3, count: 50 },
      { status_id: 4, count: 4 },
      { status_id: 5, count: 1 },
    ],
  };
}

function response(): BurnResponse {
  const buckets: Bucket[] = [10, 22, 2].map((remaining, index) => ({
    start: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    end: `2026-09-${String(index + 2).padStart(2, "0")}T00:00:00Z`,
    partial: index === 2,
    current: index === 2,
    quality: "exact",
    reasons: [],
    stock: stock(remaining),
    flow: flow(7 + index * 6),
  }));
  return {
    as_of: "2026-09-03T12:00:00Z",
    from: buckets[0]!.start,
    to: buckets[2]!.end,
    requested_grain: "auto",
    resolved_grain: "1d",
    timezone: "UTC",
    settings_version: "version-one",
    cohort: { mode: "current", count: 65 },
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
        name: "Archived open",
        category: "open",
        role: "excluded",
        color: "#7c3aed",
        position: 2,
      },
      {
        status_id: 3,
        name: "Closed remaining",
        category: "closed",
        role: "remaining",
        color: "#16a34a",
        position: 3,
      },
      {
        status_id: 4,
        name: "Closed excluded",
        category: "closed",
        role: "excluded",
        color: "#dc2626",
        position: 4,
      },
      {
        status_id: 5,
        name: "Done",
        category: "closed",
        role: "completed",
        color: "#ca8a04",
        position: 5,
      },
    ],
    opening: stock(100),
    buckets,
  };
}

function SharedSelection({ data }: { data: BurnResponse }) {
  const [selectedIndex, onSelect] = useState(0);
  const props = { data, selectedIndex, onSelect };
  return (
    <>
      <BurnChart {...props} />
      <StatusFlowChart {...props} />
      <BucketInspector {...props} />
      <BucketTable {...props} />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("insights charts", () => {
  it("plots completion from the response flow, never from opening or remaining-stock deltas", () => {
    const data = response();
    const { container, getByRole } = render(
      <BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />,
    );
    expect(
      [...container.querySelectorAll('[data-series="completed"]')].map((bar) =>
        bar.getAttribute("data-value"),
      ),
    ).toEqual(["7", "13", "19"]);
    const group = getByRole("group", { name: "Burn chart bucket selection" });
    const readId = group.getAttribute("aria-describedby")!.split(" ").at(-1)!;
    const read = container.querySelector(`[id="${readId}"]`)!.textContent;
    expect(read).toContain("Remaining: 22 (known: 22; unknown: 0)");
    expect(read).toContain("Completed: 13 (known: 13; unknown: 0)");
    expect(
      getByRole("list", { name: "Burn chart legend" }).textContent,
    ).toContain("Completed (flow)");
  });

  it("uses status categories for composition and closed bars even when burn roles disagree", () => {
    const { container, getByRole } = render(
      <StatusFlowChart
        data={response()}
        selectedIndex={0}
        onSelect={vi.fn()}
      />,
    );
    expect(
      [...container.querySelectorAll('[data-series="open-stock"]')].map(
        (path) => path.getAttribute("data-status-id"),
      ),
    ).toEqual(["1", "2"]);
    const closed = container.querySelectorAll(
      '[data-series="closed-flow"][data-bucket-index="0"]',
    );
    expect(
      [...closed].map((bar) => [
        bar.getAttribute("data-status-id"),
        bar.getAttribute("data-value"),
      ]),
    ).toEqual([
      ["3", "2"],
      ["4", "4"],
      ["5", "5"],
    ]);
    expect(
      container.querySelector(
        '[data-series="closed-flow"][data-status-id="1"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-series="open-stock-point"][data-status-id="1"]')
        ?.getAttribute("data-value"),
    ).toBe("7");
    const legend = getByRole("list", { name: "Status flow chart legend" });
    expect(legend.textContent).toContain("Open stock: Review");
    expect(legend.textContent).toContain("Closed flow: Closed excluded");
    expect(legend.textContent).toContain("Closed flow: Closed remaining");
    const readId = getByRole("group", {
      name: "Status flow chart bucket selection",
    })
      .getAttribute("aria-describedby")!
      .split(" ")
      .at(-1)!;
    expect(container.querySelector(`[id="${readId}"]`)!.textContent).toContain(
      "Closed flow, Closed excluded: 4 (known: 4; unknown: 0)",
    );
  });

  it("keeps both charts, inspector and table in one accessible controlled selection", () => {
    const { container, getByRole } = render(
      <SharedSelection data={response()} />,
    );
    const burn = getByRole("group", { name: "Burn chart bucket selection" });
    const status = getByRole("group", {
      name: "Status flow chart bucket selection",
    });
    const inspector = getByRole("region", { name: "Bucket inspector" });
    const table = getByRole("table", { name: "Insights buckets" });
    expect(burn.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(burn, { key: "ArrowRight" });
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 2" }),
    ).toBeTruthy();
    expect(
      within(table)
        .getByRole("button", { name: /Select bucket 2:/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      [...container.querySelectorAll("[data-selected-bucket]")].map((element) =>
        element.getAttribute("data-selected-bucket"),
      ),
    ).toEqual(["1", "1"]);
    fireEvent.keyDown(status, { key: "End" });
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 3" }),
    ).toBeTruthy();
    fireEvent.keyDown(status, { key: "ArrowRight" });
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 3" }),
    ).toBeTruthy();
    fireEvent.keyDown(status, { key: "ArrowUp" });
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 2" }),
    ).toBeTruthy();
    fireEvent.keyDown(burn, { key: "Home" });
    fireEvent.keyDown(burn, { key: "ArrowLeft" });
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 1" }),
    ).toBeTruthy();
    fireEvent.keyDown(burn, { key: "ArrowDown" });
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 2" }),
    ).toBeTruthy();
    fireEvent.click(
      within(table).getByRole("button", { name: /Select bucket 3:/ }),
    );
    expect(
      within(inspector).getByRole("heading", { name: "Bucket 3" }),
    ).toBeTruthy();
    expect(
      inspector.querySelector('[data-measure="flow.completed"]')!.textContent,
    ).toBe("19 (known: 19; unknown: 0)");
  });

  it("selects buckets with pointer, drag and touch, clamps edges and guards zero-width geometry", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(
      <BurnChart data={response()} selectedIndex={0} onSelect={onSelect} />,
    );
    const group = getByRole("group", { name: "Burn chart bucket selection" });
    const svg = getByRole("img", { name: "Burn chart" });
    const bounds = vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: 0,
      left: 10,
      right: 730,
      top: 0,
      bottom: 320,
      width: 720,
      height: 320,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(group, { clientX: 710, pointerId: 1, buttons: 1 });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    fireEvent.pointerMove(group, { clientX: 384, buttons: 1 });
    expect(onSelect).toHaveBeenLastCalledWith(1);
    fireEvent.pointerDown(group, { clientX: -200, pointerId: 2 });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    fireEvent.touchStart(group, { touches: [{ clientX: 384 }] });
    expect(onSelect).toHaveBeenLastCalledWith(1);
    fireEvent.touchMove(group, { touches: [{ clientX: 900 }] });
    expect(onSelect).toHaveBeenLastCalledWith(2);
    onSelect.mockClear();
    bounds.mockReturnValue({
      x: 10,
      y: 0,
      left: 10,
      right: 10,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(group, { clientX: 50, pointerId: 3 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("breaks stock paths at unknown measures without hiding independent exact completion flow", () => {
    const data = response();
    const middle = data.buckets[1]!;
    middle.stock!.remaining = unknown(8, 2);
    middle.stock!.scope = unknown(9, 2);
    middle.quality = "mixed";
    middle.reasons = ["broken_transition_chain"];
    const { container, getByRole } = render(
      <BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />,
    );
    const path = container
      .querySelector('[data-series="remaining"]')!
      .getAttribute("d")!;
    expect(path.match(/M/g)?.length).toBe(2);
    expect(path).not.toContain("L");
    expect(
      container.querySelector(
        '[data-series="remaining-point"][data-bucket-index="1"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-series="completed"][data-bucket-index="1"]')!
        .getAttribute("data-value"),
    ).toBe("13");
    const readId = getByRole("group", { name: "Burn chart bucket selection" })
      .getAttribute("aria-describedby")!
      .split(" ")
      .at(-1)!;
    expect(container.querySelector(`[id="${readId}"]`)!.textContent).toContain(
      "Unknown (known: 8; unknown: 2)",
    );
    expect(container.querySelector(`[id="${readId}"]`)!.textContent).toContain(
      "broken_transition_chain",
    );
    expect(container.querySelector("[data-unknown-bucket='1']")).toBeTruthy();
  });

  it("gaps completion bars, open composition and closed stacks when their own data is unknown", () => {
    const data = response();
    const middle = data.buckets[1]!;
    middle.stock!.open_total = unknown(10, 1);
    middle.stock!.unknown_cards = 1;
    middle.flow!.completed = unknown(3, 2);
    middle.flow!.closed_by_status[1]!.count = unknown(2, 1);
    middle.quality = "mixed";
    const { container } = render(
      <>
        <BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />
        <StatusFlowChart data={data} selectedIndex={1} onSelect={vi.fn()} />
      </>,
    );
    expect(
      container.querySelector(
        '[data-series="completed"][data-bucket-index="1"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-series="remaining-point"][data-bucket-index="1"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-series="open-stock-point"][data-bucket-index="1"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-series="closed-flow"][data-bucket-index="1"]',
      ),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-series="open-stock"]')!
        .getAttribute("d")!
        .match(/M/g)?.length,
    ).toBe(2);
    expect(
      container.querySelector('[data-unknown-open-bucket="1"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('[data-unknown-closed-bucket="1"]'),
    ).toBeTruthy();
  });

  it("reads every exact stock and flow measure, known/unknown counts, quality and bucket states", () => {
    const data = response();
    const bucket = data.buckets[2]!;
    bucket.stock!.remaining = unknown(2, 5);
    bucket.flow!.completed = unknown(7, 2);
    bucket.quality = "mixed";
    bucket.reasons = ["malformed_event", "missing_status_definition"];
    const { getByRole } = render(
      <BucketInspector data={data} selectedIndex={2} onSelect={vi.fn()} />,
    );
    const inspector = getByRole("region", { name: "Bucket inspector" });
    expect(
      inspector.querySelector('[data-measure="stock.remaining"]')!.textContent,
    ).toBe("Unknown (known: 2; unknown: 5)");
    expect(
      inspector.querySelector('[data-measure="flow.completed"]')!.textContent,
    ).toBe("Unknown (known: 7; unknown: 2)");
    for (const [key, measure] of Object.entries(bucket.flow!)) {
      if (key === "closed_by_status") continue;
      const value = measure as Measure;
      expect(
        inspector.querySelector(`[data-measure="flow.${key}"]`)!.textContent,
      ).toBe(
        value.value === null
          ? `Unknown (known: ${value.known}; unknown: ${value.unknown})`
          : `${value.value} (known: ${value.known}; unknown: ${value.unknown})`,
      );
    }
    expect(
      inspector.querySelector('[data-measure="flow.closed_by_status.4"]')!
        .textContent,
    ).toBe("4 (known: 4; unknown: 0)");
    expect(
      inspector.querySelector('[data-measure="stock.by_status.1"]')!
        .textContent,
    ).toBe("7");
    expect(within(inspector).getByText("mixed")).toBeTruthy();
    expect(within(inspector).getAllByText("Yes")).toHaveLength(2);
    expect(
      within(inspector).getByText("malformed_event, missing_status_definition"),
    ).toBeTruthy();
  });

  it("keeps all table buckets and represents unknown and not-applicable values distinctly", () => {
    const data = response();
    data.buckets[0]!.quality = "not_applicable";
    data.buckets[0]!.stock = null;
    data.buckets[0]!.flow = null;
    data.buckets[1]!.stock!.scope = unknown(6, 4);
    const onSelect = vi.fn();
    const { getByRole } = render(
      <>
        <BucketTable data={data} selectedIndex={1} onSelect={onSelect} />
        <BucketInspector data={data} selectedIndex={0} onSelect={onSelect} />
      </>,
    );
    const table = getByRole("table", { name: "Insights buckets" });
    expect(within(table).getAllByRole("button")).toHaveLength(3);
    expect(
      table.querySelector(
        '[data-bucket-index="0"] [data-measure="stock.remaining"]',
      )!.textContent,
    ).toBe("Not applicable");
    expect(
      table.querySelector(
        '[data-bucket-index="1"] [data-measure="stock.scope"]',
      )!.textContent,
    ).toBe("Unknown (known: 6; unknown: 4)");
    expect(
      table.querySelector(
        '[data-bucket-index="2"] [data-measure="flow.completed"]',
      )!.textContent,
    ).toBe("19 (known: 19; unknown: 0)");
    fireEvent.click(
      within(table).getByRole("button", { name: /Select bucket 1:/ }),
    );
    expect(onSelect).toHaveBeenCalledWith(0);
    const inspector = getByRole("region", { name: "Bucket inspector" });
    expect(within(inspector).getByText("not_applicable")).toBeTruthy();
    expect(
      inspector.querySelector('[data-measure="flow.completed"]')!.textContent,
    ).toBe("Not applicable");
  });

  it.each(["empty", "zero", "one", "all unknown", "not applicable"])(
    "renders finite geometry for %s data",
    (scenario) => {
      const data = response();
      if (scenario === "empty") data.buckets = [];
      if (scenario === "one") data.buckets = data.buckets.slice(0, 1);
      for (const bucket of data.buckets) {
        if (scenario === "not applicable") {
          bucket.quality = "not_applicable";
          bucket.stock = null;
          bucket.flow = null;
        } else if (scenario === "zero" || scenario === "all unknown") {
          const value = scenario === "zero" ? exact(0) : unknown(0, 1);
          bucket.stock!.remaining = value;
          bucket.stock!.scope = value;
          bucket.stock!.open_total = value;
          bucket.stock!.unknown_cards = scenario === "zero" ? 0 : 1;
          bucket.stock!.by_status = bucket.stock!.by_status.map((entry) => ({
            ...entry,
            count: 0,
          }));
          for (const [key] of Object.entries(bucket.flow!)) {
            if (key !== "closed_by_status")
              bucket.flow![key as Exclude<keyof Flow, "closed_by_status">] =
                value;
          }
          bucket.flow!.closed_by_status = bucket.flow!.closed_by_status.map(
            (entry) => ({ ...entry, count: value }),
          );
          bucket.quality = scenario === "zero" ? "exact" : "unknown";
        }
      }
      const onSelect = vi.fn();
      const { container, getByRole } = render(
        <>
          <BurnChart data={data} selectedIndex={999} onSelect={onSelect} />
          <StatusFlowChart
            data={data}
            selectedIndex={999}
            onSelect={onSelect}
          />
          <BucketInspector
            data={data}
            selectedIndex={999}
            onSelect={onSelect}
          />
          <BucketTable data={data} selectedIndex={999} onSelect={onSelect} />
        </>,
      );
      for (const svg of container.querySelectorAll("svg")) {
        expect(svg.outerHTML).not.toMatch(/NaN|Infinity/);
        for (const element of svg.querySelectorAll(
          "rect, circle, line, text",
        )) {
          for (const name of [
            "x",
            "y",
            "x1",
            "x2",
            "y1",
            "y2",
            "cx",
            "cy",
            "width",
            "height",
            "r",
          ]) {
            const attribute = element.getAttribute(name);
            if (attribute !== null) {
              expect(Number.isFinite(Number(attribute))).toBe(true);
              if (["width", "height", "r"].includes(name))
                expect(Number(attribute)).toBeGreaterThanOrEqual(0);
            }
          }
        }
      }
      if (scenario === "empty") {
        const group = getByRole("group", {
          name: "Burn chart bucket selection",
        });
        expect(group.getAttribute("tabindex")).toBe("-1");
        fireEvent.keyDown(group, { key: "End" });
        expect(onSelect).not.toHaveBeenCalled();
        expect(container.querySelector("[data-selected-bucket]")).toBeNull();
      }
      if (scenario === "one") {
        expect(
          container
            .querySelector('[data-series="remaining-point"]')
            ?.getAttribute("cx"),
        ).toBe("374");
        expect(
          container
            .querySelector('[data-series="open-stock"]')
            ?.getAttribute("d"),
        ).toContain("Z");
      }
      if (scenario === "all unknown" || scenario === "not applicable") {
        expect(container.querySelector('[data-series="completed"]')).toBeNull();
        expect(
          container.querySelector('[data-series="remaining-point"]'),
        ).toBeNull();
      }
    },
  );
});
