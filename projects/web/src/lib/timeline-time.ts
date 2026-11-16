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
