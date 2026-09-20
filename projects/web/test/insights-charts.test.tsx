import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type {
  ActivityDay,
  Bucket,
  BurnResponse,
  Flow,
  Measure,
  StockSnapshot,
} from "@todou/shared";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityCalendar } from "../src/components/activity-calendar/activity-calendar.tsx";
import { BurnChart } from "../src/components/insights/burn-chart.tsx";
import {
  bucketX,
  CHART_HEIGHT,
  CHART_WIDTH,
  countScale,
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  stepPath,
  timeScale,
} from "../src/components/insights/chart-frame.tsx";
import { StatusFlowChart } from "../src/components/insights/status-flow-chart.tsx";
import type {
  InsightsHover,
  InsightsLink,
  TimeSpan,
} from "../src/lib/insights-selection.ts";

// Both burn axes span the whole plot rectangle; they stay independent of each other.
const burnScale = (max: number) => countScale(max, PLOT_TOP, PLOT_BOTTOM);

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
    </>
  );
}

function linkOf(overrides: Partial<InsightsLink> = {}): InsightsLink {
  return {
    hover: null,
    selection: null,
    onHover: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

function LinkedCharts({
  data,
  link,
}: {
  data: BurnResponse;
  link: InsightsLink;
}) {
  const props = { data, selectedIndex: 0, onSelect: vi.fn(), link };
  return (
    <>
      <BurnChart {...props} />
      <StatusFlowChart {...props} />
    </>
  );
}

// The plot rectangle sits at its viewBox size, offset by 10, so a client x of
// `10 + x(time)` lands exactly on that instant.
const CLIENT_OFFSET = 10;
function layOut(svg: Element) {
  vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    x: CLIENT_OFFSET,
    y: 0,
    left: CLIENT_OFFSET,
    right: CLIENT_OFFSET + CHART_WIDTH,
    top: 0,
    bottom: CHART_HEIGHT,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    toJSON: () => ({}),
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("insights charts", () => {
  it("plots completion from flow and shows only remaining and completed in the burn chart", () => {
    const { container, getByRole } = render(
      <BurnChart data={response()} selectedIndex={1} onSelect={vi.fn()} />,
    );
    expect(
      [...container.querySelectorAll('[data-series="completed"]')].map((bar) =>
        bar.getAttribute("data-value"),
      ),
    ).toEqual(["7", "13", "19"]);
    expect(
      within(getByRole("list", { name: "Burn chart legend" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Remaining", "Completed"]);
    expect(container.querySelector('[data-series^="scope"]')).toBeNull();
    fireEvent.focus(getByRole("group", { name: "Burn chart selection" }));
    expect(getByRole("tooltip").lastElementChild?.textContent).toBe(
      "Remaining: 22 · Completed: 13",
    );
  });

  it("keeps scope out of the remaining axis even when scope is very large", () => {
    const data = response();
    const { container, rerender } = render(
      <BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />,
    );
    const axis = container.querySelector('[data-axis="Remaining"]')!.outerHTML;
    const path = container
      .querySelector('[data-series="remaining"]')!
      .getAttribute("d");
    data.opening!.scope = exact(1_000_000_000);
    for (const bucket of data.buckets) {
      bucket.stock!.scope = exact(1_000_000_000);
    }
    rerender(<BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />);
    expect(container.querySelector('[data-axis="Remaining"]')!.outerHTML).toBe(
      axis,
    );
    expect(
      container.querySelector('[data-series="remaining"]')!.getAttribute("d"),
    ).toBe(path);
  });

  it.each(["Remaining", "Completed"] as const)(
    "keeps the %s axis and geometry unchanged when the other measure becomes very large",
    (unchanged) => {
      const data = response();
      const changed = unchanged === "Remaining" ? "Completed" : "Remaining";
      const { container, rerender } = render(
        <BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />,
      );
      const axis = container.querySelector(
        `[data-axis="${unchanged}"]`,
      )!.outerHTML;
      const otherAxis = container.querySelector(
        `[data-axis="${changed}"]`,
      )!.outerHTML;
      const seriesSelector =
        unchanged === "Remaining"
          ? '[data-series="remaining"], [data-series="remaining-point"]'
          : '[data-series="completed"]';
      const before = [...container.querySelectorAll(seriesSelector)].map(
        (element) => element.outerHTML,
      );
      for (const bucket of data.buckets) {
        if (changed === "Completed") {
          bucket.flow!.completed = exact(1_000_000_000);
        } else {
          bucket.stock!.remaining = exact(1_000_000_000);
        }
      }
      rerender(<BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />);
      expect(
        container.querySelector(`[data-axis="${unchanged}"]`)!.outerHTML,
      ).toBe(axis);
      expect(
        [...container.querySelectorAll(seriesSelector)].map(
          (element) => element.outerHTML,
        ),
      ).toEqual(before);
      expect(
        container.querySelector(`[data-axis="${changed}"]`)!.outerHTML,
      ).not.toBe(otherAxis);
    },
  );

  it("shows open status composition by category and omits closed statuses from series, legend and tooltip", () => {
    const data = response();
    const { container, getByRole } = render(
      <StatusFlowChart data={data} selectedIndex={0} onSelect={vi.fn()} />,
    );
    expect(
      [...container.querySelectorAll("[data-series]")].map((path) => [
        path.getAttribute("data-series"),
        path.getAttribute("data-status-id"),
      ]),
    ).toEqual([
      ["open-stock", "1"],
      ["open-stock", "2"],
    ]);
    expect(
      within(getByRole("list", { name: "Status flow chart legend" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Review", "Archived open"]);
    fireEvent.focus(
      getByRole("group", { name: "Status flow chart selection" }),
    );
    expect(getByRole("tooltip").lastElementChild?.textContent).toBe(
      "Review: 7 · Archived open: 3",
    );
    const scale = countScale(10, PLOT_TOP, PLOT_BOTTOM);
    const x = timeScale(data.buckets);
    const firstEnd = x(Date.parse(data.buckets[0]!.end));
    const review = container.querySelector('[data-status-id="1"]')!;
    const archived = container.querySelector('[data-status-id="2"]')!;
    expect(review.getAttribute("d")).toContain(
      `M${PLOT_LEFT},${scale.y(7)} L${firstEnd},${scale.y(7)}`,
    );
    expect(archived.getAttribute("d")).toContain(
      `M${PLOT_LEFT},${scale.y(10)} L${firstEnd},${scale.y(10)}`,
    );
    expect(archived.getAttribute("d")).toContain(
      `L${firstEnd},${scale.y(7)} L${PLOT_LEFT},${scale.y(7)} Z`,
    );
  });

  it("shares keyboard selection between both charts and clamps at the first and last intervals", () => {
    const { container, getByRole } = render(
      <SharedSelection data={response()} />,
    );
    const burn = getByRole("group", { name: "Burn chart selection" });
    const status = getByRole("group", { name: "Status flow chart selection" });
    const expectSelection = (index: number) =>
      expect(
        [...container.querySelectorAll("[data-selected-bucket]")].map(
          (element) => element.getAttribute("data-selected-bucket"),
        ),
      ).toEqual([String(index), String(index)]);
    expect(burn.getAttribute("tabindex")).toBe("0");
    expect(status.getAttribute("tabindex")).toBe("0");
    expectSelection(0);
    fireEvent.keyDown(burn, { key: "ArrowRight" });
    expectSelection(1);
    expect(within(burn).getByRole("tooltip").textContent).toContain(
      "Remaining: 22 · Completed: 13",
    );
    fireEvent.keyDown(status, { key: "End" });
    expectSelection(2);
    fireEvent.keyDown(status, { key: "ArrowRight" });
    expectSelection(2);
    fireEvent.keyDown(status, { key: "ArrowUp" });
    expectSelection(1);
    fireEvent.keyDown(burn, { key: "Home" });
    expectSelection(0);
    fireEvent.keyDown(burn, { key: "ArrowLeft" });
    expectSelection(0);
    fireEvent.keyDown(burn, { key: "ArrowDown" });
    expectSelection(1);
    fireEvent.keyDown(burn, { key: "Escape" });
    expect(within(burn).queryByRole("tooltip")).toBeNull();
    expectSelection(1);
  });

  it.each([
    { Chart: BurnChart, title: "Burn chart" },
    { Chart: StatusFlowChart, title: "Status flow chart" },
  ])(
    "selects $title intervals by pointer, drag and touch in a 560-wide layout",
    ({ Chart, title }) => {
      const data = response();
      const onSelect = vi.fn();
      const { getByRole } = render(
        <Chart data={data} selectedIndex={0} onSelect={onSelect} />,
      );
      const group = getByRole("group", { name: `${title} selection` });
      const svg = getByRole("img", { name: title });
      expect(svg.getAttribute("viewBox")).toBe("0 0 560 340");
      const bounds = vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
        x: 10,
        y: 0,
        left: 10,
        right: 570,
        top: 0,
        bottom: 340,
        width: 560,
        height: 340,
        toJSON: () => ({}),
      });
      const clientX = (index: number) =>
        10 + bucketX(data.buckets[index]!, timeScale(data.buckets));
      fireEvent.pointerDown(group, {
        clientX: clientX(2),
        pointerId: 1,
        buttons: 1,
      });
      expect(onSelect).toHaveBeenLastCalledWith(2);
      fireEvent.pointerMove(group, { clientX: clientX(1), buttons: 1 });
      expect(onSelect).toHaveBeenLastCalledWith(1);
      fireEvent.pointerDown(group, { clientX: -200, pointerId: 2 });
      expect(onSelect).toHaveBeenLastCalledWith(0);
      fireEvent.touchStart(group, { touches: [{ clientX: clientX(1) }] });
      expect(onSelect).toHaveBeenLastCalledWith(1);
      fireEvent.touchMove(group, { touches: [{ clientX: 900 }] });
      expect(onSelect).toHaveBeenLastCalledWith(2);
      fireEvent.click(group, { clientX: clientX(0) });
      expect(onSelect).toHaveBeenLastCalledWith(0);
      expect(getByRole("tooltip")).toBeTruthy();
      fireEvent.pointerLeave(group);
      expect(within(group).queryByRole("tooltip")).toBeNull();
      bounds.mockReturnValue({
        x: 10,
        y: 0,
        left: 10,
        right: 290,
        top: 0,
        bottom: 170,
        width: 280,
        height: 170,
        toJSON: () => ({}),
      });
      fireEvent.pointerDown(group, {
        clientX: 10 + (clientX(2) - 10) / 2,
        pointerId: 3,
      });
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
      fireEvent.pointerDown(group, { clientX: 50, pointerId: 4 });
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("marks a hovered instant with one line and a hovered day with a band, in both charts", () => {
    const data = response();
    const x = timeScale(data.buckets);
    const at = Date.parse("2026-09-02T06:00:00Z");
    const { container, rerender } = render(
      <LinkedCharts data={data} link={linkOf({ hover: { at } })} />,
    );
    const marks = () => [...container.querySelectorAll('[data-mark="hover"]')];
    expect(marks().map((mark) => mark.tagName.toLowerCase())).toEqual([
      "line",
      "line",
    ]);
    for (const mark of marks()) {
      expect(mark.getAttribute("data-hover")).toBe("instant");
      expect(mark.getAttribute("x1")).toBe(String(x(at)));
      expect(mark.getAttribute("x2")).toBe(String(x(at)));
      expect(mark.getAttribute("y1")).toBe(String(PLOT_TOP));
      expect(mark.getAttribute("y2")).toBe(String(PLOT_BOTTOM));
    }
    // A whole activity cell has width on this axis, so it reads as a band.
    const day = {
      start: Date.parse(data.buckets[1]!.start),
      end: Date.parse(data.buckets[1]!.end),
    };
    rerender(
      <LinkedCharts data={data} link={linkOf({ hover: { at, span: day } })} />,
    );
    expect(marks().map((mark) => mark.tagName.toLowerCase())).toEqual([
      "rect",
      "rect",
    ]);
    for (const mark of marks()) {
      expect(mark.getAttribute("data-hover")).toBe("span");
      expect(Number(mark.getAttribute("x"))).toBeCloseTo(x(day.start));
      expect(Number(mark.getAttribute("width"))).toBeCloseTo(
        x(day.end) - x(day.start),
      );
      expect(Number(mark.getAttribute("y"))).toBe(PLOT_TOP);
      expect(Number(mark.getAttribute("height"))).toBe(PLOT_BOTTOM - PLOT_TOP);
    }
  });

  it("draws one vertical line while the pointer is on the chart, not two", () => {
    const data = response();
    const at = Date.parse("2026-09-02T06:00:00Z");
    const { container, getByRole } = render(
      <BurnChart
        data={data}
        selectedIndex={0}
        onSelect={vi.fn()}
        link={linkOf({ hover: { at } })}
      />,
    );
    layOut(getByRole("img", { name: "Burn chart" }));
    fireEvent.pointerMove(
      getByRole("group", { name: "Burn chart selection" }),
      { clientX: CLIENT_OFFSET + timeScale(data.buckets)(at) },
    );
    // Pointing at the chart also raises its own bucket inspector, which reads
    // the bucket's centre. Two full-height lines a few pixels apart claim two
    // different instants, so the inspector keeps the tooltip and drops its line.
    expect(getByRole("tooltip")).toBeTruthy();
    const verticals = [...container.querySelectorAll("line")].filter(
      (line) =>
        line.getAttribute("y1") === String(PLOT_TOP) &&
        line.getAttribute("y2") === String(PLOT_BOTTOM),
    );
    expect(verticals).toHaveLength(1);
    expect(verticals[0]!.getAttribute("data-hover")).toBe("instant");
  });

  it("clips the selection band to its own window and draws nothing outside it", () => {
    const data = response();
    const x = timeScale(data.buckets);
    const overrun = {
      start: Date.parse("2026-08-31T12:00:00Z"),
      end: Date.parse("2026-09-01T12:00:00Z"),
    };
    const { container, rerender } = render(
      <LinkedCharts data={data} link={linkOf({ selection: overrun })} />,
    );
    const bands = () =>
      [
        ...container.querySelectorAll('[data-mark="selection"]'),
      ] as SVGElement[];
    expect(bands()).toHaveLength(2);
    for (const band of bands()) {
      expect(Number(band.getAttribute("x"))).toBe(PLOT_LEFT);
      expect(Number(band.getAttribute("width"))).toBeCloseTo(
        x(overrun.end) - PLOT_LEFT,
      );
      expect(Number(band.getAttribute("y"))).toBe(PLOT_TOP);
      expect(Number(band.getAttribute("height"))).toBe(PLOT_BOTTOM - PLOT_TOP);
    }
    // Selections that miss this window leave no trace at all: no band, no hint.
    rerender(
      <LinkedCharts
        data={data}
        link={linkOf({
          selection: {
            start: Date.parse("2026-08-20T00:00:00Z"),
            end: Date.parse("2026-08-21T00:00:00Z"),
          },
          hover: {
            at: Date.parse("2026-08-20T06:00:00Z"),
            span: {
              start: Date.parse("2026-08-20T00:00:00Z"),
              end: Date.parse("2026-08-21T00:00:00Z"),
            },
          },
        })}
      />,
    );
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(0);
    // A selection touching the first bucket's start still ends outside it.
    rerender(
      <LinkedCharts
        data={data}
        link={linkOf({
          selection: {
            start: Date.parse("2026-08-31T00:00:00Z"),
            end: Date.parse("2026-09-01T00:00:00Z"),
          },
        })}
      />,
    );
    expect(container.querySelectorAll("[data-mark]")).toHaveLength(0);
  });

  it("selects a normalised span from a backwards drag without moving the window", () => {
    const data = response();
    const link = linkOf();
    const { container, getByRole } = render(
      <BurnChart
        data={data}
        selectedIndex={0}
        onSelect={vi.fn()}
        link={link}
      />,
    );
    layOut(getByRole("img", { name: "Burn chart" }));
    const group = getByRole("group", { name: "Burn chart selection" });
    const x = timeScale(data.buckets);
    const axis = container.querySelector('[data-axis="time"]')!.outerHTML;
    const later = Date.parse("2026-09-03T00:00:00Z");
    const earlier = Date.parse("2026-09-01T12:00:00Z");
    fireEvent.pointerDown(group, {
      clientX: CLIENT_OFFSET + x(later),
      pointerId: 1,
    });
    fireEvent.pointerMove(group, {
      clientX: CLIENT_OFFSET + x(earlier),
      pointerId: 1,
      buttons: 1,
    });
    fireEvent.pointerUp(group, {
      clientX: CLIENT_OFFSET + x(earlier),
      pointerId: 1,
    });
    const span = vi.mocked(link.onSelect).mock.lastCall![0]!;
    expect(span.start).toBeLessThan(span.end);
    expect(span.start).toBeCloseTo(earlier, -3);
    expect(span.end).toBeCloseTo(later, -3);
    // Reading a range never rescales the axis it was read from.
    expect(container.querySelector('[data-axis="time"]')!.outerHTML).toBe(axis);

    // A click keeps its existing meaning — inspect this bucket. Selecting on it
    // too would hand the reader a band on their very first click, and the only
    // gesture that takes one back is Escape.
    vi.mocked(link.onSelect).mockClear();
    const clicked = data.buckets[1]!;
    const middle = CLIENT_OFFSET + bucketX(clicked, x);
    fireEvent.pointerDown(group, { clientX: middle, pointerId: 2, button: 0 });
    fireEvent.pointerUp(group, { clientX: middle + 1, pointerId: 2 });
    expect(link.onSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(group, { key: "Escape" });
    expect(link.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("refuses to drag from a non-primary button, or once one is released", () => {
    const data = response();
    const link = linkOf();
    const { container } = render(
      <BurnChart
        data={data}
        selectedIndex={0}
        onSelect={vi.fn()}
        link={link}
      />,
    );
    const group = container.querySelector("fieldset")!;
    layOut(container.querySelector("svg")!);
    const x = timeScale(data.buckets);
    const from =
      CLIENT_OFFSET + x(Date.parse(data.buckets[0]!.start) + 3_600_000);
    const to = CLIENT_OFFSET + x(Date.parse(data.buckets[2]!.start));

    // A right-click's release can be swallowed by the context menu.
    fireEvent.pointerDown(group, { clientX: from, pointerId: 3, button: 2 });
    fireEvent.pointerMove(group, { clientX: to, pointerId: 3, buttons: 2 });
    expect(link.onSelect).not.toHaveBeenCalled();

    // And a primary drag whose release never arrives must not keep extending
    // on bare movement afterwards.
    fireEvent.pointerDown(group, { clientX: from, pointerId: 4, button: 0 });
    fireEvent.pointerMove(group, { clientX: to, pointerId: 4, buttons: 0 });
    expect(link.onSelect).not.toHaveBeenCalled();
  });

  it("reports the instant under the pointer and clears it on leave", () => {
    const data = response();
    const link = linkOf();
    const { getByRole } = render(
      <StatusFlowChart
        data={data}
        selectedIndex={0}
        onSelect={vi.fn()}
        link={link}
      />,
    );
    layOut(getByRole("img", { name: "Status flow chart" }));
    const group = getByRole("group", { name: "Status flow chart selection" });
    const x = timeScale(data.buckets);
    const at = Date.parse("2026-09-02T12:00:00Z");
    fireEvent.pointerMove(group, { clientX: CLIENT_OFFSET + x(at) });
    const hover = vi.mocked(link.onHover).mock.lastCall![0]!;
    expect(hover.at).toBeCloseTo(at, -3);
    expect(hover.span).toBeUndefined();
    expect(link.onSelect).not.toHaveBeenCalled();
    // The last instant of the window, never the exclusive end past its edge.
    fireEvent.pointerMove(group, {
      clientX: CLIENT_OFFSET + CHART_WIDTH + 200,
    });
    expect(vi.mocked(link.onHover).mock.lastCall![0]!.at).toBe(
      Date.parse(data.buckets[2]!.end) - 1,
    );
    fireEvent.pointerLeave(group);
    expect(link.onHover).toHaveBeenLastCalledWith(null);
  });

  it("breaks the remaining step across an unknown interval and retains its independent completed bar", () => {
    const data = response();
    const middle = data.buckets[1]!;
    middle.stock!.remaining = unknown(8, 2);
    middle.quality = "mixed";
    const { container, getByRole } = render(
      <BurnChart data={data} selectedIndex={1} onSelect={vi.fn()} />,
    );
    const x = timeScale(data.buckets);
    const y = burnScale(10).y;
    const path = container
      .querySelector('[data-series="remaining"]')!
      .getAttribute("d")!;
    expect(path.split(" M")).toEqual([
      `M${PLOT_LEFT},${y(10)} L${x(Date.parse(middle.start))},${y(10)}`,
      `${x(Date.parse(middle.end))},${y(2)} L${PLOT_RIGHT},${y(2)}`,
    ]);
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
    fireEvent.focus(getByRole("group", { name: "Burn chart selection" }));
    expect(getByRole("tooltip").lastElementChild?.textContent).toBe(
      "Remaining: — · Completed: 13",
    );
  });

  it.each(["unknown total", "unknown cards", "missing stock"] as const)(
    "gaps open composition for %s while preserving independently known burn measures",
    (scenario) => {
      const data = response();
      const middle = data.buckets[1]!;
      if (scenario === "unknown total") {
        middle.stock!.open_total = unknown(10, 1);
      } else if (scenario === "unknown cards") {
        middle.stock!.unknown_cards = 1;
      } else {
        middle.stock = null;
      }
      const { container, getByRole } = render(<SharedSelection data={data} />);
      const x = timeScale(data.buckets);
      for (const path of container.querySelectorAll(
        '[data-series="open-stock"]',
      )) {
        const segments = path.getAttribute("d")!.match(/M[^M]+/g)!;
        expect(segments).toHaveLength(2);
        expect(segments[0]).toContain(` L${x(Date.parse(middle.start))},`);
        expect(segments[0]).toMatch(/ Z\s*$/);
        expect(segments[1]!.startsWith(`M${x(Date.parse(middle.end))},`)).toBe(
          true,
        );
        expect(segments[1]).toContain(` L${PLOT_RIGHT},`);
        expect(segments[1]).toMatch(/ Z$/);
      }
      expect(
        container
          .querySelector('[data-series="completed"][data-bucket-index="1"]')!
          .getAttribute("data-value"),
      ).toBe("13");
      if (scenario !== "missing stock") {
        expect(
          container
            .querySelector(
              '[data-series="remaining-point"][data-bucket-index="1"]',
            )!
            .getAttribute("data-value"),
        ).toBe("22");
      }
      fireEvent.keyDown(
        getByRole("group", { name: "Status flow chart selection" }),
        { key: "ArrowRight" },
      );
      expect(getByRole("tooltip").lastElementChild?.textContent).toBe(
        "Review: — · Archived open: —",
      );
    },
  );

  it("omits an unknown completed bar without breaking known remaining or open composition", () => {
    const data = response();
    data.buckets[1]!.flow!.completed = unknown(3, 2);
    const { container, getByRole } = render(<SharedSelection data={data} />);
    expect(
      [...container.querySelectorAll('[data-series="completed"]')].map((bar) =>
        bar.getAttribute("data-bucket-index"),
      ),
    ).toEqual(["0", "2"]);
    expect(
      container
        .querySelector('[data-series="remaining"]')!
        .getAttribute("d")!
        .match(/M/g),
    ).toHaveLength(1);
    expect(
      container
        .querySelector(
          '[data-series="remaining-point"][data-bucket-index="1"]',
        )!
        .getAttribute("data-value"),
    ).toBe("22");
    for (const path of container.querySelectorAll(
      '[data-series="open-stock"]',
    )) {
      expect(path.getAttribute("d")!.match(/M/g)).toHaveLength(1);
    }
    fireEvent.keyDown(getByRole("group", { name: "Burn chart selection" }), {
      key: "ArrowRight",
    });
    expect(getByRole("tooltip").lastElementChild?.textContent).toBe(
      "Remaining: 22 · Completed: —",
    );
  });

  it("uses elapsed time for step boundaries, bar widths and selection across DST and a short final interval", () => {
    const data = response();
    // New York's spring transition: 24 hours, 23 hours, then 6 hours.
    const boundaries = [
      "2026-03-07T00:00:00-05:00",
      "2026-03-08T00:00:00-05:00",
      "2026-03-09T00:00:00-04:00",
      "2026-03-09T06:00:00-04:00",
    ];
    data.timezone = "America/New_York";
    data.from = boundaries[0]!;
    data.to = boundaries[3]!;
    data.as_of = boundaries[3]!;
    data.buckets.forEach((bucket, index) => {
      bucket.start = boundaries[index]!;
      bucket.end = boundaries[index + 1]!;
    });
    const x = timeScale(data.buckets);
    const width = PLOT_RIGHT - PLOT_LEFT;
    expect(x(Date.parse(boundaries[0]!))).toBe(PLOT_LEFT);
    expect(x(Date.parse(boundaries[1]!))).toBeCloseTo(
      PLOT_LEFT + (width * 24) / 53,
    );
    expect(x(Date.parse(boundaries[2]!))).toBeCloseTo(
      PLOT_LEFT + (width * 47) / 53,
    );
    expect(x(Date.parse(boundaries[3]!))).toBe(PLOT_RIGHT);
    expect(bucketX(data.buckets[2]!, x)).toBeCloseTo(
      PLOT_LEFT + (width * 50) / 53,
    );
    const { container, getByRole } = render(<SharedSelection data={data} />);
    const bars = container.querySelectorAll('[data-series="completed"]');
    expect(bars).toHaveLength(3);
    for (const [index, hours] of [24, 23, 6].entries()) {
      expect(Number(bars[index]!.getAttribute("width"))).toBeCloseTo(
        ((width * hours) / 53) * 0.57,
      );
      const center =
        Number(bars[index]!.getAttribute("x")) +
        Number(bars[index]!.getAttribute("width")) / 2;
      expect(center).toBeCloseTo(
        PLOT_LEFT + (width * [12, 35.5, 50][index]!) / 53,
      );
    }
    const y = burnScale(22).y;
    const remaining = container.querySelector('[data-series="remaining"]')!;
    expect(remaining.getAttribute("d")).toContain(
      `L${x(Date.parse(boundaries[1]!))},${y(10)} L${x(Date.parse(boundaries[1]!))},${y(22)}`,
    );
    expect(remaining.getAttribute("d")).toContain(
      `L${x(Date.parse(boundaries[2]!))},${y(22)} L${x(Date.parse(boundaries[2]!))},${y(2)}`,
    );
    for (const path of container.querySelectorAll(
      '[data-series="open-stock"]',
    )) {
      for (const boundary of boundaries.slice(1, 3)) {
        expect(path.getAttribute("d")).toContain(
          `L${x(Date.parse(boundary))},`,
        );
      }
    }
    for (const title of ["Burn chart", "Status flow chart"]) {
      const svg = getByRole("img", { name: title });
      vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
        x: 10,
        y: 0,
        left: 10,
        right: 570,
        top: 0,
        bottom: CHART_HEIGHT,
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
        toJSON: () => ({}),
      });
      const group = getByRole("group", { name: `${title} selection` });
      for (const [hours, selected] of [
        [20, 0],
        [40, 1],
        [50, 2],
      ] as const) {
        fireEvent.pointerMove(group, {
          clientX: 10 + PLOT_LEFT + (width * hours) / 53,
        });
        expect(
          [...container.querySelectorAll("[data-selected-bucket]")].map(
            (element) => element.getAttribute("data-selected-bucket"),
          ),
        ).toEqual([String(selected), String(selected)]);
      }
    }
  });

  it("draws observed values across their full intervals and restarts after unknown intervals", () => {
    const buckets = response().buckets;
    const hours = (time: number) =>
      (time - Date.parse(buckets[0]!.start)) / 3_600_000;
    expect(stepPath(buckets, [10, 22, 2], hours, (value) => value)).toBe(
      "M0,10 L24,10 L24,22 L48,22 L48,2 L72,2",
    );
    expect(stepPath(buckets, [10, null, 2], hours, (value) => value)).toBe(
      "M0,10 L24,10 M48,2 L72,2",
    );
    expect(stepPath(buckets, [null, 0, null], hours, (value) => value)).toBe(
      "M24,0 L48,0",
    );
  });

  it.each([0, 1, 2, 7, 22, 1_000_000_000])(
    "uses zero-based integer count axes for a maximum of %s",
    (max) => {
      const scales = [
        {
          label: "Remaining",
          top: PLOT_TOP,
          bottom: PLOT_BOTTOM,
          intervals: 4,
        },
        {
          label: "Completed",
          top: PLOT_TOP,
          bottom: PLOT_BOTTOM,
          intervals: 4,
        },
        { label: "Open", top: PLOT_TOP, bottom: PLOT_BOTTOM, intervals: 4 },
      ];
      const data = response();
      for (const bucket of data.buckets) {
        bucket.stock!.remaining = exact(max);
        bucket.flow!.completed = exact(max);
        bucket.stock!.open_total = exact(max);
        bucket.stock!.by_status = [{ status_id: 1, count: max }];
      }
      const { container } = render(<SharedSelection data={data} />);
      for (const { label, top, bottom, intervals } of scales) {
        const scale = countScale(max, top, bottom, intervals);
        expect(scale.ticks[0]).toBe(0);
        expect(scale.ticks.every(Number.isInteger)).toBe(true);
        expect(scale.ticks.at(-1)).toBeGreaterThanOrEqual(Math.max(1, max));
        expect(scale.y(0)).toBe(bottom);
        expect(scale.y(scale.ticks.at(-1)!)).toBe(top);
        expect(scale.y(max)).toBeGreaterThanOrEqual(top);
        expect(scale.y(max)).toBeLessThanOrEqual(bottom);
        for (let index = 1; index < scale.ticks.length; index++) {
          expect(scale.ticks[index]).toBeGreaterThan(scale.ticks[index - 1]!);
        }
        const axis = container.querySelector(`[data-axis="${label}"]`)!;
        const ticks = [...axis.querySelectorAll(":scope > g > text")].map(
          (text) => Number(text.textContent),
        );
        expect(ticks).toEqual(scale.ticks);
        expect(
          [...axis.querySelectorAll("line")].map((line) =>
            Number(line.getAttribute("y1")),
          ),
        ).toEqual(scale.ticks.map(scale.y));
      }
    },
  );

  it.each([
    [1, [0, 1]],
    [7, [0, 2, 4, 6, 8]],
    [22, [0, 5, 10, 15, 20, 25]],
    [40, [0, 10, 20, 30, 40]],
    [45, [0, 10, 20, 30, 40, 50]],
    [47, [0, 10, 20, 30, 40, 50]],
  ])(
    "puts a maximum of %s under a ceiling that follows the data",
    (max, ticks) => {
      // Literal oracles, not a second call to countScale: the ceiling is the
      // whole point. Four rounded steps used to put 22 under 40 and 45 under 80.
      expect(countScale(max, PLOT_TOP, PLOT_BOTTOM).ticks).toEqual(ticks);
    },
  );

  it.each([25, 50])(
    "lets a maximum of %s sit exactly on the top gridline",
    (max) => {
      // A nice step divides these exactly, so the series touches PLOT_TOP with
      // no headroom. That is deliberate: inventing a step to leave room is what
      // produced the loose axes, and the SVG has room above PLOT_TOP to draw in.
      const scale = countScale(max, PLOT_TOP, PLOT_BOTTOM);
      expect(scale.ticks.at(-1)).toBe(max);
      expect(scale.y(max)).toBe(PLOT_TOP);
    },
  );

  it("reads remaining off the left edge and completed off the right", () => {
    const { container } = render(
      <BurnChart data={response()} selectedIndex={1} onSelect={vi.fn()} />,
    );
    const axisOf = (label: string) => {
      const axis = container.querySelector(`[data-axis="${label}"]`)!;
      const tick = axis.querySelector(":scope > g")!;
      return {
        side: axis.getAttribute("data-side"),
        label: axis.querySelector(":scope > text")!,
        line: tick.querySelector("line")!,
        text: tick.querySelector("text")!,
      };
    };
    const left = axisOf("Remaining");
    const right = axisOf("Completed");

    expect(left.side).toBe("left");
    expect(left.text.getAttribute("x")).toBe(String(PLOT_LEFT - 10));
    expect(left.text.getAttribute("text-anchor")).toBe("end");
    expect(left.label.getAttribute("x")).toBe(String(PLOT_LEFT));
    expect(left.label.getAttribute("text-anchor")).toBe("start");
    // Only the left axis owns gridlines; a second full-width set would double
    // every stroke.
    expect(left.line.getAttribute("x1")).toBe(String(PLOT_LEFT));
    expect(left.line.getAttribute("x2")).toBe(String(PLOT_RIGHT));

    expect(right.side).toBe("right");
    expect(right.text.getAttribute("x")).toBe(String(PLOT_RIGHT + 8));
    expect(right.text.getAttribute("text-anchor")).toBe("start");
    expect(right.label.getAttribute("x")).toBe(String(PLOT_RIGHT));
    expect(right.label.getAttribute("text-anchor")).toBe("end");
    expect(right.line.getAttribute("x1")).toBe(String(PLOT_RIGHT));
    expect(right.line.getAttribute("x2")).toBe(String(PLOT_RIGHT + 4));
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
          bucket.stock!.open_total = value;
          bucket.stock!.unknown_cards = scenario === "zero" ? 0 : 1;
          bucket.stock!.by_status = bucket.stock!.by_status.map((entry) => ({
            ...entry,
            count: 0,
          }));
          bucket.flow!.completed = value;
          bucket.quality = scenario === "zero" ? "exact" : "unknown";
        }
      }
      const onSelect = vi.fn();
      const { container, getByRole, getAllByText } = render(
        <>
          <BurnChart data={data} selectedIndex={999} onSelect={onSelect} />
          <StatusFlowChart
            data={data}
            selectedIndex={999}
            onSelect={onSelect}
          />
        </>,
      );
      const svgs = container.querySelectorAll("svg");
      expect(svgs).toHaveLength(2);
      for (const svg of svgs) {
        expect(svg.outerHTML).not.toMatch(/NaN|Infinity/);
        for (const path of svg.querySelectorAll("path[d]")) {
          const coordinates = path
            .getAttribute("d")!
            .replace(/[MLZ]/g, " ")
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number);
          expect(coordinates.every(Number.isFinite)).toBe(true);
        }
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
              if (["width", "height", "r"].includes(name)) {
                expect(Number(attribute)).toBeGreaterThanOrEqual(0);
              }
            }
          }
        }
      }
      if (scenario === "empty") {
        expect(getAllByText("No data in this range.")).toHaveLength(2);
        for (const title of ["Burn chart", "Status flow chart"]) {
          const group = getByRole("group", { name: `${title} selection` });
          expect(group.getAttribute("tabindex")).toBe("-1");
          fireEvent.keyDown(group, { key: "End" });
          fireEvent.pointerDown(group, { clientX: 100, pointerId: 1 });
        }
        expect(onSelect).not.toHaveBeenCalled();
        expect(container.querySelector("[data-selected-bucket]")).toBeNull();
      } else {
        for (const svg of svgs) {
          expect(svg.getAttribute("data-selected-bucket")).toBe(
            String(data.buckets.length - 1),
          );
        }
      }
      if (scenario === "one") {
        const midpoint = (PLOT_LEFT + PLOT_RIGHT) / 2;
        expect(
          Number(
            container
              .querySelector('[data-series="remaining-point"]')!
              .getAttribute("cx"),
          ),
        ).toBe(midpoint);
        const y = burnScale(10).y(10);
        expect(
          container
            .querySelector('[data-series="remaining"]')!
            .getAttribute("d"),
        ).toBe(`M${PLOT_LEFT},${y} L${PLOT_RIGHT},${y}`);
        for (const path of container.querySelectorAll(
          '[data-series="open-stock"]',
        )) {
          expect(path.getAttribute("d")).toMatch(/ Z$/);
          expect(path.getAttribute("d")).toContain(`M${PLOT_LEFT},`);
          expect(path.getAttribute("d")).toContain(`L${PLOT_RIGHT},`);
        }
      }
      if (scenario === "zero") {
        const bars = container.querySelectorAll('[data-series="completed"]');
        expect(bars).toHaveLength(3);
        for (const bar of bars) {
          expect(Number(bar.getAttribute("height"))).toBe(0);
          expect(Number(bar.getAttribute("y"))).toBe(PLOT_BOTTOM);
        }
        const points = container.querySelectorAll(
          '[data-series="remaining-point"]',
        );
        expect(points).toHaveLength(3);
        for (const point of points) {
          expect(Number(point.getAttribute("cy"))).toBe(PLOT_BOTTOM);
        }
      }
      if (scenario === "all unknown" || scenario === "not applicable") {
        expect(container.querySelector('[data-series="completed"]')).toBeNull();
        expect(
          container.querySelector('[data-series="remaining-point"]'),
        ).toBeNull();
        for (const path of container.querySelectorAll("path[data-series]")) {
          expect(path.getAttribute("d")).toBe("");
        }
      }
    },
  );
});

// The unit tests above hand each surface a link by hand. These drive a real
// pointer across real components sharing one state, which is the only place
// the two halves of the contract meet.
describe("insights linked surfaces", () => {
  const WINDOW = { from: "2026-09-01", to: "2026-09-08" };

  function activityDays(): ActivityDay[] {
    return Array.from({ length: 7 }, (_, offset) => {
      const date = `2026-09-0${offset + 1}`;
      return {
        date,
        state: "recorded",
        count: offset,
        start: `${date}T00:00:00.000Z`,
        end: `2026-09-0${offset + 2}T00:00:00.000Z`,
      };
    });
  }

  function LinkedSurfaces({ data }: { data: BurnResponse }) {
    const [hover, setHover] = useState<InsightsHover | null>(null);
    const [selection, setSelection] = useState<TimeSpan | null>(null);
    const [selectedIndex, onSelect] = useState(0);
    const link: InsightsLink = {
      hover,
      selection,
      onHover: setHover,
      onSelect: setSelection,
    };
    return (
      <>
        <BurnChart
          data={data}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          link={link}
        />
        <ActivityCalendar
          {...WINDOW}
          days={activityDays()}
          selection={null}
          today="2026-09-07"
          onDayChange={vi.fn()}
          onRetry={vi.fn()}
          link={link}
        />
      </>
    );
  }

  function setUp() {
    const data = response();
    const view = render(<LinkedSurfaces data={data} />);
    layOut(view.getByRole("img", { name: "Burn chart" }));
    return {
      ...view,
      data,
      group: view.getByRole("group", { name: "Burn chart selection" }),
      x: timeScale(data.buckets),
      cell: (date: string) =>
        view.container.querySelector(`[data-date="${date}"]`)!,
      mark: (date: string, kind: string) =>
        view.container.querySelector(
          `[data-date="${date}"] [data-mark="${kind}"]`,
        ),
    };
  }

  it("outlines the cell holding the instant the pointer reads off a chart", () => {
    const { group, x, mark } = setUp();
    fireEvent.pointerMove(group, {
      clientX: CLIENT_OFFSET + x(Date.parse("2026-09-02T06:00:00Z")),
    });
    expect(mark("2026-09-02", "hover")).toBeTruthy();
    expect(mark("2026-09-01", "hover")).toBeNull();
    expect(mark("2026-09-03", "hover")).toBeNull();
  });

  it("keeps the margin past a chart's right edge inside its last day", () => {
    const { group, mark } = setUp();
    // The window is half-open, so its exclusive `end` is midnight owned by the
    // next cell. Reading it raw would outline a day the chart never covered.
    fireEvent.pointerMove(group, {
      clientX: CLIENT_OFFSET + CHART_WIDTH + 200,
    });
    expect(mark("2026-09-03", "hover")).toBeTruthy();
    expect(mark("2026-09-04", "hover")).toBeNull();
  });

  it("reads a hovered activity cell as a band on the chart, never a line", () => {
    const { container, cell } = setUp();
    fireEvent.pointerEnter(cell("2026-09-02").parentElement as HTMLElement);
    const marks = [...container.querySelectorAll('svg [data-mark="hover"]')];
    expect(marks.map((node) => node.getAttribute("data-hover"))).toEqual([
      "span",
    ]);
    expect(marks[0]!.tagName.toLowerCase()).toBe("rect");
  });

  it("fills each cell over the hours a chart drag selected", () => {
    const { group, x, container, mark } = setUp();
    const from = Date.parse("2026-09-01T12:00:00Z");
    const to = Date.parse("2026-09-03T12:00:00Z");
    fireEvent.pointerDown(group, { clientX: CLIENT_OFFSET + x(from) });
    fireEvent.pointerMove(group, {
      clientX: CLIENT_OFFSET + x(to),
      buttons: 1,
    });
    fireEvent.pointerUp(group, { clientX: CLIENT_OFFSET + x(to) });
    // Noon to noon two days later: half of the first cell from its middle down,
    // all of the second, half of the third from its top.
    const band = (date: string) => {
      const node = mark(date, "selection") as HTMLElement;
      return [parseFloat(node.style.top), parseFloat(node.style.height)];
    };
    expect(band("2026-09-01")[0]).toBeCloseTo(50, 1);
    expect(band("2026-09-01")[1]).toBeCloseTo(50, 1);
    expect(band("2026-09-02")).toEqual([0, 100]);
    expect(band("2026-09-03")[0]).toBeCloseTo(0, 1);
    expect(band("2026-09-03")[1]).toBeCloseTo(50, 1);
    expect(mark("2026-09-04", "selection")).toBeNull();
    // The drag reads the window; it never moves it.
    expect(
      container.querySelectorAll('svg [data-mark="selection"]'),
    ).toHaveLength(1);
  });
});
