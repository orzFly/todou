/**
 * The time a timeline row shows: a comment header, an event row, an action
 * line (T-696). Minutes, not seconds — two entries a few seconds apart are
 * told apart by their order, and the seconds were most of what made a column
 * of `11/12/2026, 7:09:00 AM` read as noise. The exact instant stays one
 * hover away, in the `title` every caller sets to the ISO string.
 *
 * Locale-following like the `toLocaleString()` it replaces, so a reader
 * whose browser writes dates day-first still gets them day-first. Built once:
 * a timeline formats hundreds of these on first render.
 */
const TIMELINE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatTimelineTime(iso: string): string {
  return TIMELINE_TIME.format(new Date(iso));
}

/**
 * Where a timeline row's time goes below `sm`, where the row is inline flow
 * that wraps like a sentence: against the right edge, on the row's last line
 * if it fits there and on a line of its own if it does not — the same side a
 * comment header's time takes when it wraps (T-696). A float placed after the
 * text does exactly that, which no inline element can.
 *
 * A float starts a line of its own, and lines of 12px and 14px text of one
 * height put their baselines 1px apart. So the float is set as the row is,
 * `text-sm` on `leading-5`, and only the `<time>` inside it is drawn at
 * `text-xs`: it sits on the float's 14px baseline, which is the row's.
 */
export const TIMELINE_TIME_NARROW =
  "max-sm:float-right max-sm:ms-2 max-sm:text-sm max-sm:leading-5 max-sm:*:text-xs";

/** The row a `TIMELINE_TIME_NARROW` time floats in, which has to contain it. */
export const TIMELINE_ROW_NARROW = "max-sm:flow-root";
