/** Half-open instant range, epoch milliseconds. */
export interface TimeSpan {
  start: number;
  end: number;
}

/**
 * What the reader is pointing at. `span` is present when the pointer covers a
 * whole interval (an activity cell) rather than one instant.
 */
export interface InsightsHover {
  at: number;
  span?: TimeSpan;
}

/**
 * The only coupling between the charts and the activity calendar. The page
 * owns both values, so a pointer on one surface draws on all of them.
 */
export interface InsightsLink {
  hover: InsightsHover | null;
  selection: TimeSpan | null;
  onHover: (hover: InsightsHover | null) => void;
  onSelect: (selection: TimeSpan | null) => void;
}

/**
 * Ranges that only touch do not overlap: a day's `end` is the next day's
 * `start`, and exactly one of the two may claim that instant.
 */
export function spanOverlap(a: TimeSpan, b: TimeSpan): TimeSpan | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

/** `end` belongs to the next span, not to this one. */
export function spanContains(span: TimeSpan, at: number): boolean {
  return at >= span.start && at < span.end;
}

/**
 * Fraction of `day` covered by `selection`, as [topFraction, bottomFraction]
 * measured from the start of the day; null when they do not overlap.
 */
export function dayCoverage(
  day: TimeSpan,
  selection: TimeSpan,
): [number, number] | null {
  const overlap = spanOverlap(day, selection);
  // A skipped civil date spans no instant at all (Apia's 2011-12-30), so
  // nothing can overlap it and the divisor below is never zero.
  if (overlap === null) return null;
  const length = day.end - day.start;
  return [
    (overlap.start - day.start) / length,
    (overlap.end - day.start) / length,
  ];
}
