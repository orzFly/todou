import {
  type ActivityDay,
  type ActivitySelection,
  enumLookup,
} from "@todou/shared";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface ActivityCalendarProps {
  /** Inclusive first local date of the window. The parent owns URL state and fetching. */
  from: string;
  /** Exclusive last local date of the window. */
  to: string;
  /** Complete DTO days for the window; [] while no snapshot is available. Counts are never inferred. */
  days: readonly ActivityDay[];
  /** Selection from the same snapshot as days. Only its date is used here. */
  selection: ActivitySelection | null;
  /** YYYY-MM-DD at the response cutoff in its timezone, supplied by the parent. */
  today: string;
  /** Requests a recorded date. Moving keyboard focus never calls this callback. */
  onDayChange: (date: string) => void;
  /** True for initial loading or refresh; an existing snapshot stays visible. */
  loading?: boolean;
  /** Safe request error text. Errors never become a calendar of zeroes. */
  error?: string | null;
  /** Retry the parent-owned request. */
  onRetry: () => void;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const RAMP = ["bg-primary/25", "bg-primary/45", "bg-primary/70", "bg-primary"];
const ARROW_STEPS: Record<string, number | undefined> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
};

export interface ActivityLevel {
  label: string;
  className: string;
  /** Inclusive upper bound of the counts this level covers; 0 for the empty level. */
  bound: number;
}

/**
 * Quartiles of the counts actually on screen, so each swatch carries about a
 * quarter of the active days. Cutting the 0..max *range* into four instead
 * reads the ramp off the busiest day alone: one day of 40 against a month of
 * ones puts every ordinary day in the lightest bucket and tells the reader
 * nothing about how they differ.
 *
 * Nearest-rank, and duplicate cuts are dropped rather than repeated — a set
 * with few distinct counts genuinely has fewer levels to show, which is also
 * why a quiet project still reaches the darkest swatch.
 */
export function activityLevels(counts: readonly number[]): ActivityLevel[] {
  // Zero is its own level; it must not drag the quartiles down with it.
  const active = [...counts].filter((count) => count > 0).sort((a, b) => a - b);
  const bounds: number[] = [];
  for (let index = 1; index <= RAMP.length; index++) {
    const rank = Math.ceil((active.length * index) / RAMP.length);
    const bound = active[Math.max(0, rank - 1)];
    if (bound !== undefined && bound !== bounds.at(-1)) bounds.push(bound);
  }
  return [
    { label: "0", className: "bg-muted", bound: 0 },
    ...bounds.map((bound, index) => {
      const lower = (bounds[index - 1] ?? 0) + 1;
      return {
        label: lower === bound ? String(bound) : `${lower}–${bound}`,
        className:
          RAMP[
            bounds.length === 1
              ? RAMP.length - 1
              : Math.round((index * (RAMP.length - 1)) / (bounds.length - 1))
          ] ?? RAMP[RAMP.length - 1],
        bound,
      };
    }),
  ];
}

function level(count: number, levels: readonly ActivityLevel[]): number {
  const index = levels.findIndex((entry) => count <= entry.bound);
  return index < 0 ? levels.length - 1 : index;
}

// Gregorian geometry only: no local Date midnight, timestamps, or timezone
// conversion. DTO date strings remain the identity of each server-side bucket.
function monthLength(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ] as number;
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Sakamoto's congruence, rotated so Monday is row 0. */
function weekdayIndex(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const shift = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][month - 1] as number;
  const base = month < 3 ? year - 1 : year;
  const sunday =
    (base +
      Math.floor(base / 4) -
      Math.floor(base / 100) +
      Math.floor(base / 400) +
      shift +
      day) %
    7;
  return (sunday + 6) % 7;
}

/** Half-open [from, to) of local dates; a year is just one window among many. */
function windowGeometry(from: string, to: string) {
  const dates: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  let day = Number(from.slice(8, 10));
  // The server caps the span; this bound only stops a malformed pair looping.
  while (dates.length < 400) {
    const date = isoDate(year, month, day);
    if (date >= to) break;
    dates.push(date);
    day += 1;
    if (day > monthLength(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  const offset = dates[0] ? weekdayIndex(dates[0]) : 0;
  return { dates, offset, weeks: Math.ceil((dates.length + offset) / 7) };
}

function dayLabel(date: string, day: ActivityDay | undefined) {
  const value = day
    ? enumLookup(
        {
          recorded: `${day.count} active ${day.count === 1 ? "card" : "cards"}`,
          future: "Future date",
          not_applicable: "Not applicable",
        } satisfies Record<ActivityDay["state"], string>,
        day.state,
        () => "Unknown activity state",
        "ActivityDay.state",
      )
    : "No data";
  return `${date}: ${value}`;
}

/** Pure display and interaction: callers atomically supply a calendar snapshot. */
export function ActivityCalendar({
  from,
  to,
  days,
  selection,
  today,
  onDayChange,
  loading = false,
  error = null,
  onRetry,
}: ActivityCalendarProps) {
  const id = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const calendar = useRef<HTMLFieldSetElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const heldFocus = useRef(false);
  const { dates, offset, weeks } = windowGeometry(from, to);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const levels = activityLevels(
    days.map((day) => (day.state === "recorded" ? day.count : 0)),
  );
  const recorded = dates.filter(
    (date) => byDate.get(date)?.state === "recorded",
  );
  const selectedDate = selection?.date ?? null;
  const defaultDate =
    selectedDate && recorded.includes(selectedDate)
      ? selectedDate
      : recorded.includes(today)
        ? today
        : (recorded.at(-1) ?? null);
  const [rovingDate, setRovingDate] = useState<string | null>(defaultDate);
  const [inspectedDate, setInspectedDate] = useState<string | null>(null);
  const activeDate =
    rovingDate && recorded.includes(rovingDate) ? rovingDate : defaultDate;

  // A changed controlled selection (including back/forward) resets the tab stop.
  // Move DOM focus only if the user was already navigating the dates.
  useEffect(() => {
    const focused = document.activeElement;
    // A parent clears selection while the requested day's cards load. Keep
    // the reader on that date until the new controlled selection arrives.
    const retained =
      selectedDate === null &&
      focused instanceof HTMLButtonElement &&
      calendar.current?.contains(focused) &&
      !focused.disabled
        ? focused.dataset.date
        : undefined;
    const next = retained ?? defaultDate;
    setRovingDate(next);
    setInspectedDate(null);
    if (next && calendar.current?.contains(focused)) {
      buttons.current.get(next)?.focus();
    }
  }, [defaultDate, selectedDate]);

  // Ref cleanup runs before a focused date is removed on a year change.
  // After removal activeElement is body, so a post-commit contains() cannot
  // tell whether this calendar owned focus. Never steal it from another control.
  useEffect(() => {
    if (!heldFocus.current) return;
    if (document.activeElement !== document.body) {
      heldFocus.current = false;
    } else if (activeDate) {
      heldFocus.current = false;
      buttons.current.get(activeDate)?.focus();
    }
  });

  useEffect(() => {
    const releaseFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !calendar.current?.contains(event.target)
      ) {
        heldFocus.current = false;
      }
    };
    document.addEventListener("focusin", releaseFocus);
    return () => document.removeEventListener("focusin", releaseFocus);
  }, []);

  useEffect(() => {
    const focused = document.activeElement;
    // Losing every selectable date must not drop a keyboard reader on <body>.
    // The heading outlives any window, so it is the landing point once the grid
    // can no longer hold focus -- whether its dates were removed outright or
    // merely turned unselectable, which blurs them without unmounting them.
    if (activeDate === null) {
      const owned =
        calendar.current?.contains(focused) ||
        (heldFocus.current && focused === document.body);
      if (!loading && !error && owned) {
        heldFocus.current = false;
        heading.current?.focus();
      }
    } else if (
      calendar.current?.contains(focused) &&
      focused instanceof HTMLButtonElement &&
      focused.disabled
    ) {
      buttons.current.get(activeDate)?.focus();
    }
  }, [activeDate, loading, error]);

  function focusDate(date: string) {
    setRovingDate(date);
    setInspectedDate(date);
    buttons.current.get(date)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (typeof event.key !== "string") return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat) onDayChange(dates[index]);
      return;
    }
    let next = index;
    const step = enumLookup(
      ARROW_STEPS,
      event.key,
      () => undefined,
      "KeyboardEvent.key",
    );
    if (step !== undefined) {
      next += step;
      while (
        next >= 0 &&
        next < dates.length &&
        byDate.get(dates[next])?.state !== "recorded"
      ) {
        next += step;
      }
    } else if (event.key === "Home" || event.key === "End") {
      const start = index - ((index + offset) % 7);
      const first = Math.max(0, start);
      const last = Math.min(dates.length - 1, start + 6);
      const direction = event.key === "Home" ? 1 : -1;
      next = direction === 1 ? first : last;
      while (
        next >= first &&
        next <= last &&
        byDate.get(dates[next])?.state !== "recorded"
      ) {
        next += direction;
      }
    } else {
      return;
    }
    event.preventDefault();
    if (
      next >= 0 &&
      next < dates.length &&
      byDate.get(dates[next])?.state === "recorded"
    ) {
      focusDate(dates[next]);
    }
  }

  const readDate =
    inspectedDate && dates.includes(inspectedDate) ? inspectedDate : activeDate;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      aria-busy={loading}
      className="w-full min-w-0 max-w-full space-y-3 rounded-xl border bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          ref={heading}
          id={`${id}-heading`}
          tabIndex={-1}
          className="font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          Activity
        </h2>
      </div>
      {/* A refresh keeps the mounted calendar at its size: only the cold load
          may take layout, so an update never moves what the reader is aiming at. */}
      {loading && (
        <p role="status" className="sr-only">
          Loading activity…
        </p>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            disabled={loading}
            className="rounded border px-2 py-1 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      )}
      <p id={`${id}-instructions`} className="sr-only">
        Up and Down move one day; Left and Right move one week. Home and End
        move to the first and last available day of the week. Enter or Space
        selects a day.
      </p>
      {/* The grid's geometry comes from the window, not from the response, so
          it is always drawn: a cold load shows the cells it is about to fill
          rather than a differently sized block that then swaps for them, and a
          refresh never collapses the grid the reader is pointing at. */}
      <div
        className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain"
        data-activity-scroll
      >
        <fieldset
          ref={calendar}
          aria-label={`Activity dates ${from} to ${dates.at(-1) ?? from}`}
          aria-describedby={`${id}-instructions`}
          className="m-0 grid w-full min-w-0 gap-1 border-0 p-1"
          style={{
            // Fluid columns with a floor, not a fixed 1rem: 52 weeks of fixed
            // cells are wider than any container this sits in, so the grid
            // always wore a scrollbar. It now takes the width it is given, and
            // only falls back to scrolling once cells would go under the floor.
            gridTemplateColumns: `2.5rem repeat(${weeks}, minmax(0.5rem, 1fr))`,
            gridTemplateRows: "1rem repeat(7, auto)",
          }}
        >
          {WEEKDAYS.map((name, index) => (
            <span
              key={name}
              aria-hidden="true"
              className="text-[10px] text-muted-foreground"
              style={{ gridColumn: 1, gridRow: index + 2 }}
            >
              {name}
            </span>
          ))}
          {dates.map((date, index) => {
            const day = byDate.get(date);
            const enabled = day?.state === "recorded";
            const intensity = enabled ? level(day.count, levels) : undefined;
            const label = dayLabel(date, day);
            const column = Math.floor((index + offset) / 7) + 2;
            return (
              <span key={date} className="contents">
                {date.endsWith("-01") && (
                  <span
                    aria-hidden="true"
                    className="text-[10px] text-muted-foreground"
                    style={{ gridColumn: `${column} / span 3`, gridRow: 1 }}
                  >
                    {MONTHS[Number(date.slice(5, 7)) - 1]}
                  </span>
                )}
                <span
                  className="flex w-full min-w-0"
                  style={{
                    gridColumn: column,
                    gridRow: ((index + offset) % 7) + 2,
                  }}
                  onPointerEnter={() => setInspectedDate(date)}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== "touch") setInspectedDate(null);
                  }}
                  onPointerDown={(event) => {
                    if (event.pointerType === "touch") setInspectedDate(date);
                  }}
                >
                  <button
                    ref={(node) => {
                      if (node) buttons.current.set(date, node);
                      else {
                        if (
                          buttons.current.get(date) === document.activeElement
                        ) {
                          heldFocus.current = true;
                        }
                        buttons.current.delete(date);
                      }
                    }}
                    type="button"
                    disabled={!enabled}
                    tabIndex={enabled && activeDate === date ? 0 : -1}
                    aria-label={label}
                    aria-pressed={enabled ? selectedDate === date : undefined}
                    aria-current={date === today ? "date" : undefined}
                    aria-describedby={
                      readDate === date ? `${id}-readout` : undefined
                    }
                    data-date={date}
                    data-state={day?.state ?? "unavailable"}
                    data-level={intensity}
                    className={cn(
                      "aspect-square w-full min-w-0 rounded-xs border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      intensity !== undefined
                        ? levels[intensity]?.className
                        : "bg-transparent",
                      day?.state === "future" && "border-dashed opacity-50",
                      day?.state === "not_applicable" &&
                        "border-transparent bg-muted/30",
                      enabled &&
                        selectedDate === date &&
                        "outline-2 outline-offset-2 outline-primary",
                    )}
                    onFocus={() => {
                      heldFocus.current = true;
                      setRovingDate(date);
                      setInspectedDate(date);
                    }}
                    onKeyDown={(event) => onKeyDown(event, index)}
                    onClick={() => {
                      focusDate(date);
                      onDayChange(date);
                    }}
                  />
                </span>
              </span>
            );
          })}
        </fieldset>
      </div>
      {/* Still the description `aria-describedby` points at, so it keeps its
          role; it simply no longer takes a line under the grid restating the
          count that the selected day's own heading already carries. */}
      {readDate && (
        <p
          id={`${id}-readout`}
          role="tooltip"
          aria-live="polite"
          className="sr-only"
        >
          {dayLabel(readDate, byDate.get(readDate))}
        </p>
      )}
      {!loading && !error && recorded.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No available dates in this range.
        </p>
      )}
      <ul
        aria-label="Active cards per day"
        className="flex flex-wrap gap-3 text-xs text-muted-foreground"
      >
        {levels.map((entry) => (
          <li key={entry.label} className="inline-flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cn("size-3 rounded-xs border", entry.className)}
            />
            {entry.label}
          </li>
        ))}
      </ul>
    </section>
  );
}
