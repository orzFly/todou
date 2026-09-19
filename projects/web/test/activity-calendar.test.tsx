import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ActivityDay, ActivitySelection } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityCalendar,
  type ActivityCalendarProps,
} from "../src/components/activity-calendar/activity-calendar.tsx";

// Fixture generation uses UTC Date; the component uses integer Gregorian
// geometry. Explicit weekday/leap/count oracles below do not copy its formula.
function daysFor(year = 2024, overrides: ActivityDay[] = []): ActivityDay[] {
  const date = new Date(`${String(year).padStart(4, "0")}-01-01T00:00:00Z`);
  const days: ActivityDay[] = [];
  while (date.getUTCFullYear() === year) {
    const key = date.toISOString().slice(0, 10);
    days.push(
      overrides.find((day) => day.date === key) ?? {
        date: key,
        state: "recorded",
        count: 0,
      },
    );
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return days;
}

function selected(date: string): ActivitySelection {
  return { date, total: 876543, items: [], has_more: false, next_cursor: null };
}

function props(
  overrides: Partial<ActivityCalendarProps> = {},
): ActivityCalendarProps {
  return {
    year: 2024,
    days: daysFor(),
    selection: selected("2024-01-10"),
    today: "2026-09-18",
    onYearChange: vi.fn(),
    onDayChange: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
}

function tile(date: string): HTMLButtonElement {
  return screen.getByRole("button", {
    name: new RegExp(`^${date}:`),
  }) as HTMLButtonElement;
}

function focus(date: string) {
  act(() => tile(date).focus());
}

function tabStops(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button[data-date]"),
  )
    .filter((button) => button.tabIndex === 0)
    .map((button) => button.dataset.date);
}

describe("ActivityCalendar dates and counts", () => {
  it.each([
    [2024, 366, true],
    [2025, 365, false],
    [1900, 365, false],
    [2000, 366, true],
    [1, 365, false],
  ])(
    "renders exactly year %i (%i days), including Gregorian leap rules",
    (year, count, leap) => {
      const prefix = String(year).padStart(4, "0");
      const { container } = render(
        <ActivityCalendar
          {...props({ year, days: daysFor(year), selection: null })}
        />,
      );
      const buttons = container.querySelectorAll("button[data-date]");
      expect(buttons.length).toBe(count);
      expect(buttons[0]?.getAttribute("data-date")).toBe(`${prefix}-01-01`);
      expect(buttons[count - 1]?.getAttribute("data-date")).toBe(
        `${prefix}-12-31`,
      );
      expect(
        container.querySelector(`[data-date="${prefix}-02-29"]`) !== null,
      ).toBe(leap);
      expect(
        container.querySelector(`[data-date="${year + 1}-01-01"]`),
      ).toBeNull();
    },
  );

  it("places Monday first, weeks in columns, and month labels over the right week", () => {
    render(
      <ActivityCalendar
        {...props({ year: 2026, days: daysFor(2026), selection: null })}
      />,
    );
    // January 1, 2026 is Thursday, January 5 is the next Monday.
    expect(tile("2026-01-01").parentElement?.style.gridRow).toBe("5");
    expect(tile("2026-01-01").parentElement?.style.gridColumn).toBe("2");
    expect(tile("2026-01-04").parentElement?.style.gridRow).toBe("8");
    expect(tile("2026-01-05").parentElement?.style.gridRow).toBe("2");
    expect(tile("2026-01-05").parentElement?.style.gridColumn).toBe("3");
    expect(screen.getByText("Jan").style.gridColumn).toBe("2 / span 3");
    expect(screen.getByText("Feb").style.gridColumn).toBe("6 / span 3");
    const group = screen.getByRole("group", { name: "2026 activity dates" });
    expect(group.style.gridTemplateColumns).toBe("2.5rem repeat(53, 1rem)");
    expect(group.style.gridTemplateRows).toBe("1rem repeat(7, 1rem)");
  });

  it("uses fixed thresholds and exact DTO counts, never selection total or a relative scale", () => {
    const counts = [0, 1, 3, 4, 6, 7, 9, 10, 12345];
    const days = daysFor(
      2024,
      counts.map((count, index) => ({
        date: `2024-01-0${index + 1}`,
        state: "recorded",
        count,
      })),
    );
    const { container } = render(<ActivityCalendar {...props({ days })} />);
    const expected = ["0", "1", "1", "2", "2", "3", "3", "4", "4"];
    counts.forEach((count, index) => {
      const button = tile(`2024-01-0${index + 1}`);
      expect(button.dataset.level).toBe(expected[index]);
      expect(button.getAttribute("aria-label")).toBe(
        `2024-01-0${index + 1}: ${count} active ${count === 1 ? "card" : "cards"}`,
      );
    });
    expect(tile("2024-01-08").className).toBe(tile("2024-01-09").className);
    expect(tile("2024-01-03").className).not.toBe(tile("2024-01-04").className);
    expect(
      within(screen.getByRole("list", { name: "Active cards per day" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["0", "1–3", "4–6", "7–9", "10+"]);
    expect(container.textContent).not.toMatch(
      /876543|annual|year total|incomplete|history quality/i,
    );
  });

  it("leaves future and not_applicable disabled without a fake zero or a level", () => {
    const p = props({
      days: daysFor(2024, [
        { date: "2024-01-01", state: "not_applicable", count: null },
        { date: "2024-01-02", state: "future", count: null },
      ]),
    });
    render(<ActivityCalendar {...p} />);
    for (const date of ["2024-01-01", "2024-01-02"]) {
      expect(tile(date).disabled).toBe(true);
      expect(tile(date).tabIndex).toBe(-1);
      expect(tile(date).hasAttribute("data-level")).toBe(false);
      expect(tile(date).getAttribute("aria-label")).not.toMatch(/0 active/);
      fireEvent.click(tile(date));
    }
    expect(tile("2024-01-01").getAttribute("aria-label")).toBe(
      "2024-01-01: Not applicable",
    );
    expect(tile("2024-01-02").getAttribute("aria-label")).toBe(
      "2024-01-02: Future date",
    );
    expect(tile("2024-01-01").className).not.toBe(tile("2024-01-02").className);
    expect(tile("2024-01-03").disabled).toBe(false);
    fireEvent.click(tile("2024-01-03"));
    expect(p.onDayChange).toHaveBeenCalledExactlyOnceWith("2024-01-03");
  });

  it("uses supplied today and distinguishes selected and today outlines", () => {
    render(<ActivityCalendar {...props({ today: "2024-01-11" })} />);
    expect(tile("2024-01-11").getAttribute("aria-current")).toBe("date");
    expect(tile("2024-01-11").className).toContain("ring-1");
    expect(tile("2024-01-11").getAttribute("aria-pressed")).toBe("false");
    expect(tile("2024-01-10").getAttribute("aria-pressed")).toBe("true");
    expect(tile("2024-01-10").className).toContain("outline-primary");
    expect(tile("2024-01-10").hasAttribute("aria-current")).toBe(false);
    expect(tile("2024-01-12").className).not.toContain("outline-primary");
  });

  it.each(["2024-03-10", "2024-11-03", "2024-02-29"])(
    "selects the exact DTO date %s without browser timezone bucketing",
    (date) => {
      const p = props({
        days: daysFor(2024, [{ date, state: "recorded", count: 8 }]),
      });
      render(<ActivityCalendar {...p} />);
      fireEvent.click(tile(date));
      expect(p.onDayChange).toHaveBeenCalledExactlyOnceWith(date);
      expect(screen.getByRole("tooltip").textContent).toBe(
        `${date}: 8 active cards`,
      );
    },
  );

  it("preserves the skipped civil date from the server as unavailable", () => {
    const p = props({
      year: 2011,
      days: daysFor(2011, [
        { date: "2011-12-30", state: "not_applicable", count: null },
      ]),
      selection: selected("2011-12-29"),
    });
    render(<ActivityCalendar {...p} />);
    focus("2011-12-29");
    fireEvent.keyDown(tile("2011-12-29"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tile("2011-12-31"));
    expect(tile("2011-12-30").disabled).toBe(true);
    expect(p.onDayChange).not.toHaveBeenCalled();
  });
});

describe("ActivityCalendar keyboard and inspection", () => {
  it.each([
    ["ArrowUp", "2024-01-09"],
    ["ArrowDown", "2024-01-11"],
    ["ArrowLeft", "2024-01-03"],
    ["ArrowRight", "2024-01-17"],
    ["Home", "2024-01-08"],
    ["End", "2024-01-14"],
  ])(
    "%s moves focus to %s but never selects or changes the year",
    (key, target) => {
      const p = props();
      const { container } = render(<ActivityCalendar {...p} />);
      expect(tabStops(container)).toEqual(["2024-01-10"]);
      focus("2024-01-10");
      expect(fireEvent.keyDown(tile("2024-01-10"), { key })).toBe(false);
      expect(document.activeElement).toBe(tile(target));
      expect(tabStops(container)).toEqual([target]);
      expect(tile("2024-01-10").getAttribute("aria-pressed")).toBe("true");
      expect(tile(target).getAttribute("aria-pressed")).toBe("false");
      expect(p.onDayChange).not.toHaveBeenCalled();
      expect(p.onYearChange).not.toHaveBeenCalled();
      expect(screen.getByRole("tooltip").textContent).toBe(
        `${target}: 0 active cards`,
      );
    },
  );

  it.each([
    ["ArrowUp", ["2024-01-09", "2024-01-08"], "2024-01-07"],
    ["ArrowDown", ["2024-01-11", "2024-01-12"], "2024-01-13"],
    ["ArrowLeft", ["2024-01-10", "2024-01-03"], "2024-01-17"],
    ["ArrowRight", ["2024-01-24", "2024-01-31"], "2024-02-07"],
  ])(
    "%s skips disabled dates along its day/week direction",
    (key, disabled, target) => {
      const start =
        key === "ArrowLeft" || key === "ArrowRight"
          ? "2024-01-17"
          : "2024-01-10";
      const p = props({
        selection: selected(start),
        days: daysFor(
          2024,
          disabled.map((date, index) => ({
            date,
            state: index === 0 ? "not_applicable" : "future",
            count: null,
          })),
        ),
      });
      render(<ActivityCalendar {...p} />);
      focus(start);
      fireEvent.keyDown(tile(start), { key });
      expect(document.activeElement).toBe(tile(target));
      expect(p.onDayChange).not.toHaveBeenCalled();
    },
  );

  it("Home/End stay within the week and skip disabled endpoints", () => {
    const p = props({
      days: daysFor(2024, [
        { date: "2024-01-08", state: "not_applicable", count: null },
        { date: "2024-01-14", state: "future", count: null },
      ]),
    });
    render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    fireEvent.keyDown(tile("2024-01-10"), { key: "Home" });
    expect(document.activeElement).toBe(tile("2024-01-09"));
    fireEvent.keyDown(tile("2024-01-09"), { key: "End" });
    expect(document.activeElement).toBe(tile("2024-01-13"));
    expect(p.onDayChange).not.toHaveBeenCalled();
  });

  it("handles partial first/last weeks and never wraps across year boundaries", () => {
    const p = props({ year: 2026, days: daysFor(2026), selection: null });
    render(<ActivityCalendar {...p} />);
    focus("2026-01-02");
    fireEvent.keyDown(tile("2026-01-02"), { key: "Home" });
    expect(document.activeElement).toBe(tile("2026-01-01"));
    for (const key of ["ArrowUp", "ArrowLeft"]) {
      fireEvent.keyDown(tile("2026-01-01"), { key });
      expect(document.activeElement).toBe(tile("2026-01-01"));
    }
    focus("2026-12-29");
    fireEvent.keyDown(tile("2026-12-29"), { key: "End" });
    expect(document.activeElement).toBe(tile("2026-12-31"));
    for (const key of ["ArrowDown", "ArrowRight"]) {
      fireEvent.keyDown(tile("2026-12-31"), { key });
      expect(document.activeElement).toBe(tile("2026-12-31"));
    }
    expect(p.onDayChange).not.toHaveBeenCalled();
    expect(p.onYearChange).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])(
    "%s alone selects the focused date, without a duplicate on keyup or repeat",
    (key) => {
      const p = props();
      render(<ActivityCalendar {...p} />);
      focus("2024-01-10");
      fireEvent.keyDown(tile("2024-01-10"), { key: "ArrowDown" });
      fireEvent.keyDown(tile("2024-01-11"), { key });
      fireEvent.keyUp(tile("2024-01-11"), { key });
      fireEvent.keyDown(tile("2024-01-11"), { key, repeat: true });
      expect(p.onDayChange).toHaveBeenCalledExactlyOnceWith("2024-01-11");
      // The parent must supply a new selection before the selected outline moves.
      expect(tile("2024-01-10").getAttribute("aria-pressed")).toBe("true");
    },
  );

  it("leaves unknown native keys and browser-modified arrows alone", () => {
    const p = props();
    const { container } = render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    for (const event of [
      { key: "Tab" },
      { key: "Escape" },
      { key: "a" },
      { key: "Unidentified" },
      { key: "future_key" },
      // React normalizes prototype names before the component sees event.key.
      // These exercise native dispatch, not literal prototype-string lookup.
      // The enum source guard detects a return to bare ARROW_STEPS indexing.
      { key: "constructor" },
      { key: "__proto__" },
      { key: "toString" },
      { key: "ArrowLeft", altKey: true },
      { key: "ArrowRight", metaKey: true },
      { key: "ArrowUp", ctrlKey: true },
    ]) {
      expect(fireEvent.keyDown(tile("2024-01-10"), event)).toBe(true);
      expect(document.activeElement).toBe(tile("2024-01-10"));
      expect(tabStops(container)).toEqual(["2024-01-10"]);
    }
    expect(p.onDayChange).not.toHaveBeenCalled();
    expect(p.onYearChange).not.toHaveBeenCalled();
    // A handler that ignores every key must still fail this regression.
    expect(fireEvent.keyDown(tile("2024-01-10"), { key: "ArrowDown" })).toBe(
      false,
    );
    expect(document.activeElement).toBe(tile("2024-01-11"));
    expect(tabStops(container)).toEqual(["2024-01-11"]);
    expect(p.onDayChange).not.toHaveBeenCalled();
    expect(p.onYearChange).not.toHaveBeenCalled();
  });

  it("ignores non-string keys produced by React native-key normalization without reporting errors", () => {
    const p = props();
    const { container } = render(<ActivityCalendar {...p} />);
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      focus("2024-01-10");
      for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
        // Dispatch real native events: React itself turns these keys into
        // inherited functions/objects; do not overwrite the synthetic key.
        expect(fireEvent.keyDown(tile("2024-01-10"), { key })).toBe(true);
        expect(errors, key).toEqual([]);
        expect(document.activeElement).toBe(tile("2024-01-10"));
        expect(tabStops(container)).toEqual(["2024-01-10"]);
      }
      expect(p.onDayChange).not.toHaveBeenCalled();
      expect(p.onYearChange).not.toHaveBeenCalled();
      fireEvent.keyDown(tile("2024-01-10"), { key: "ArrowDown" });
      expect(document.activeElement).toBe(tile("2024-01-11"));
      fireEvent.keyDown(tile("2024-01-11"), { key: "Home" });
      expect(document.activeElement).toBe(tile("2024-01-08"));
      fireEvent.keyDown(tile("2024-01-08"), { key: "Enter" });
      expect(p.onDayChange).toHaveBeenCalledExactlyOnceWith("2024-01-08");
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("exposes exact labels on focus, hover and touch, including disabled dates", () => {
    const p = props({
      days: daysFor(2024, [
        { date: "2024-01-11", state: "recorded", count: 42 },
        { date: "2024-01-12", state: "future", count: null },
      ]),
    });
    render(<ActivityCalendar {...p} />);
    focus("2024-01-11");
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2024-01-11: 42 active cards",
    );
    expect(tile("2024-01-11").getAttribute("aria-describedby")).toBe(
      screen.getByRole("tooltip").id,
    );
    fireEvent.pointerEnter(tile("2024-01-12").parentElement as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2024-01-12: Future date",
    );
    fireEvent.pointerLeave(tile("2024-01-12").parentElement as HTMLElement);
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2024-01-11: 42 active cards",
    );
    fireEvent.pointerDown(tile("2024-01-12").parentElement as HTMLElement, {
      pointerType: "touch",
    });
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2024-01-12: Future date",
    );
    expect(p.onDayChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(tile("2024-01-12").parentElement as HTMLElement, {
      pointerType: "touch",
    });
    fireEvent.pointerLeave(tile("2024-01-12").parentElement as HTMLElement, {
      pointerType: "touch",
    });
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2024-01-12: Future date",
    );
    fireEvent.pointerDown(tile("2024-01-11"), { pointerType: "touch" });
    fireEvent.click(tile("2024-01-11"));
    expect(screen.getByRole("tooltip").textContent).toBe(
      "2024-01-11: 42 active cards",
    );
    expect(p.onDayChange).toHaveBeenCalledExactlyOnceWith("2024-01-11");
  });
});

describe("ActivityCalendar controlled state and recovery", () => {
  it("uses today then the final recorded date as the initial tab stop, without auto-selecting", () => {
    const p = props({ today: "2024-01-12", selection: null });
    const { container, rerender } = render(<ActivityCalendar {...p} />);
    expect(tabStops(container)).toEqual(["2024-01-12"]);
    rerender(<ActivityCalendar {...p} today="2026-09-18" />);
    expect(tabStops(container)).toEqual(["2024-12-31"]);
    expect(p.onDayChange).not.toHaveBeenCalled();
  });

  it("follows controlled selection changes, retaining one tab stop and moving focus within the calendar", () => {
    const p = props();
    const { container, rerender } = render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    fireEvent.keyDown(tile("2024-01-10"), { key: "ArrowRight" });
    rerender(<ActivityCalendar {...p} selection={selected("2024-02-29")} />);
    expect(tabStops(container)).toEqual(["2024-02-29"]);
    expect(document.activeElement).toBe(tile("2024-02-29"));
    expect(tile("2024-01-10").getAttribute("aria-pressed")).toBe("false");
    expect(tile("2024-02-29").getAttribute("aria-pressed")).toBe("true");
    expect(p.onDayChange).not.toHaveBeenCalled();
  });

  it("restores date focus after replacing the entire year, without stealing focus from Year", () => {
    const p = props();
    const { container, rerender } = render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    rerender(
      <ActivityCalendar
        {...p}
        year={2025}
        days={daysFor(2025)}
        selection={selected("2025-03-04")}
      />,
    );
    expect(document.activeElement).toBe(tile("2025-03-04"));
    expect(tabStops(container)).toEqual(["2025-03-04"]);
    act(() => screen.getByRole("spinbutton").focus());
    rerender(
      <ActivityCalendar
        {...p}
        year={2026}
        days={daysFor(2026)}
        selection={selected("2026-03-04")}
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("spinbutton"));
    expect(tabStops(container)).toEqual(["2026-03-04"]);
    expect(p.onDayChange).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains pending focus through year loading, unless focus moved outside: %s",
    (moveOutside) => {
      const p = props();
      const { rerender } = render(<ActivityCalendar {...p} />);
      focus("2024-01-10");
      rerender(
        <ActivityCalendar
          {...p}
          year={2025}
          days={[]}
          selection={null}
          loading
        />,
      );
      if (moveOutside) act(() => screen.getByRole("spinbutton").focus());
      rerender(
        <ActivityCalendar
          {...p}
          year={2025}
          days={daysFor(2025)}
          selection={selected("2025-03-04")}
        />,
      );
      expect(document.activeElement).toBe(
        moveOutside ? screen.getByRole("spinbutton") : tile("2025-03-04"),
      );
      expect(p.onDayChange).not.toHaveBeenCalled();
    },
  );

  it("keeps a roving date through loading/error changes and recovers if it becomes disabled", () => {
    const p = props();
    const { container, rerender } = render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    fireEvent.keyDown(tile("2024-01-10"), { key: "ArrowDown" });
    rerender(<ActivityCalendar {...p} loading />);
    expect(document.activeElement).toBe(tile("2024-01-11"));
    rerender(<ActivityCalendar {...p} error="Refresh failed." />);
    expect(document.activeElement).toBe(tile("2024-01-11"));
    const days = daysFor(2024, [
      { date: "2024-01-11", state: "not_applicable", count: null },
    ]);
    rerender(<ActivityCalendar {...p} days={days} />);
    expect(document.activeElement).toBe(tile("2024-01-10"));
    expect(tabStops(container)).toEqual(["2024-01-10"]);
    expect(p.onDayChange).not.toHaveBeenCalled();
  });

  it("keeps a non-today focused date when selection clears for the next request", () => {
    const p = props({ today: "2024-01-12" });
    const { container, rerender } = render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    fireEvent.keyDown(tile("2024-01-10"), { key: "ArrowDown" });
    fireEvent.keyDown(tile("2024-01-11"), { key: "Enter" });
    rerender(<ActivityCalendar {...p} selection={null} loading />);
    expect(document.activeElement).toBe(tile("2024-01-11"));
    expect(tabStops(container)).toEqual(["2024-01-11"]);
    expect(tile("2024-01-10").getAttribute("aria-pressed")).toBe("false");
    rerender(<ActivityCalendar {...p} selection={selected("2024-01-11")} />);
    expect(document.activeElement).toBe(tile("2024-01-11"));
    expect(tile("2024-01-11").getAttribute("aria-pressed")).toBe("true");
    expect(p.onDayChange).toHaveBeenCalledExactlyOnceWith("2024-01-11");
  });

  it("returns focus to Year when an entire year is not applicable", () => {
    const p = props();
    const { container, rerender } = render(<ActivityCalendar {...p} />);
    focus("2024-01-10");
    const days: ActivityDay[] = daysFor().map(({ date }) => ({
      date,
      state: "not_applicable",
      count: null,
    }));
    rerender(<ActivityCalendar {...p} days={days} selection={null} />);
    expect(tabStops(container)).toEqual([]);
    expect(document.activeElement).toBe(
      screen.getByRole("spinbutton", { name: "Year" }),
    );
    expect(screen.getByText("No available dates in 2024.")).not.toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByRole("button", { name: /0 active cards/ })).toBeNull();
    expect(p.onDayChange).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "empty year restores owned focus but respects an outside input: %s",
    (moveOutside) => {
      const p = props();
      const tree = (loading: boolean) => (
        <>
          <input aria-label="Outside calendar" />
          <ActivityCalendar
            {...p}
            year={2025}
            days={[]}
            selection={null}
            loading={loading}
          />
        </>
      );
      const { rerender } = render(
        <>
          <input aria-label="Outside calendar" />
          <ActivityCalendar {...p} />
        </>,
      );
      focus("2024-01-10");
      rerender(tree(true));
      if (moveOutside)
        act(() =>
          screen.getByRole("textbox", { name: "Outside calendar" }).focus(),
        );
      rerender(tree(false));
      expect(screen.getByText("No available dates in 2025.")).not.toBeNull();
      expect(document.activeElement).toBe(
        moveOutside
          ? screen.getByRole("textbox", { name: "Outside calendar" })
          : screen.getByRole("spinbutton", { name: "Year" }),
      );
    },
  );

  it("requests historical years without project metadata or timezone controls", () => {
    const p = props();
    const { container } = render(<ActivityCalendar {...p} />);
    const year = screen.getByRole("spinbutton", { name: "Year" });
    expect(year.getAttribute("min")).toBe("1");
    expect(year.getAttribute("max")).toBe("2026");
    fireEvent.change(year, { target: { value: "1999" } });
    expect(p.onYearChange).toHaveBeenCalledExactlyOnceWith(1999);
    for (const value of ["", "0", "2027", "1.5", "9999", "2024"])
      fireEvent.change(year, { target: { value } });
    expect(p.onYearChange).toHaveBeenCalledTimes(1);
    expect(p.onDayChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(container.textContent).not.toMatch(
      /timezone|project created|earliest contribution/i,
    );
  });

  it("separates initial loading, request error, retry and no available dates", () => {
    const p = props({ days: [], selection: null, loading: true });
    const { rerender } = render(<ActivityCalendar {...p} />);
    expect(screen.getByRole("status").textContent).toBe("Loading activity…");
    expect(screen.queryByText(/No available dates/)).toBeNull();
    expect(screen.queryByRole("button", { name: /active cards/ })).toBeNull();
    rerender(
      <ActivityCalendar
        {...p}
        loading={false}
        error="Activity could not be loaded."
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Activity could not be loaded.",
    );
    expect(screen.queryByText(/No available dates/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    rerender(<ActivityCalendar {...p} error="Activity could not be loaded." />);
    expect(
      (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(p.onRetry).toHaveBeenCalledOnce();
    rerender(<ActivityCalendar {...p} loading={false} />);
    expect(screen.getByText("No available dates in 2024.")).not.toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("spinbutton"));
  });

  it("preserves real counts while refreshing or showing a failed refresh", () => {
    const p = props({
      days: daysFor(2024, [
        { date: "2024-01-10", state: "recorded", count: 17 },
      ]),
    });
    const { rerender } = render(<ActivityCalendar {...p} loading />);
    expect(tile("2024-01-10").getAttribute("aria-label")).toBe(
      "2024-01-10: 17 active cards",
    );
    expect(
      screen
        .getByRole("region", { name: "Activity" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    rerender(<ActivityCalendar {...p} error="Refresh failed." />);
    expect(tile("2024-01-10").getAttribute("aria-label")).toBe(
      "2024-01-10: 17 active cards",
    );
    expect(screen.getByRole("alert").textContent).toContain("Refresh failed.");
    expect(screen.queryByText(/No available dates/)).toBeNull();
  });

  it("never turns a missing date or a previous year's snapshot into zero", () => {
    const p = props({
      days: [{ date: "2024-01-10", state: "recorded", count: 3 }],
    });
    const { rerender } = render(<ActivityCalendar {...p} />);
    expect(tile("2024-01-11").disabled).toBe(true);
    expect(tile("2024-01-11").getAttribute("aria-label")).toBe(
      "2024-01-11: No data",
    );
    expect(tile("2024-01-11").hasAttribute("data-level")).toBe(false);
    rerender(<ActivityCalendar {...p} year={2025} loading />);
    expect(screen.queryByRole("button", { name: /^2024-/ })).toBeNull();
    expect(tile("2025-01-10").getAttribute("aria-label")).toBe(
      "2025-01-10: No data",
    );
    expect(tile("2025-01-10").disabled).toBe(true);
  });

  it("confines the wide weekly grid to a local scroll container at narrow widths", () => {
    const { container } = render(
      <div style={{ width: 390 }}>
        <ActivityCalendar {...props()} />
      </div>,
    );
    const scroller = container.querySelector("[data-activity-scroll]");
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(scroller?.className).toContain("max-w-full");
    expect(scroller?.className).toContain("min-w-0");
    expect(
      screen.getByRole("region", { name: "Activity" }).className,
    ).toContain("min-w-0");
    expect(screen.getByRole("group").parentElement).toBe(scroller);
    expect(screen.getByRole("group").className).toContain("w-max");
  });
});
