import type { Bucket, BurnResponse, Measure } from "@todou/shared";
import { type ReactNode, useId, useRef, useState } from "react";
import {
  type InsightsLink,
  spanContains,
  spanOverlap,
  type TimeSpan,
} from "@/lib/insights-selection.ts";

export interface InsightsSelectionProps {
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export interface InsightsBucketProps extends InsightsSelectionProps {
  data: BurnResponse;
  className?: string;
  // One prop, not four: this component already has an `onSelect` of its own for
  // the inspected bucket, and the linked selection speaks in instants.
  link?: InsightsLink;
}

export interface ChartLegendEntry {
  label: string;
  color: string;
  line?: boolean;
}

export interface ChartFrameProps extends InsightsBucketProps {
  title: string;
  legend: readonly ChartLegendEntry[];
  bucketRead: (bucket: Bucket, index: number) => string;
  children: ReactNode;
}

export const CHART_WIDTH = 560;
export const CHART_HEIGHT = 340;
export const PLOT_LEFT = 43;
// Symmetric margins leave the right-hand axis the same room as the left, and
// keep every chart's plot rectangle identical so one x position means the same
// instant in all of them -- which is what makes the linked hover line up.
export const PLOT_RIGHT = 517;
export const PLOT_TOP = 30;
export const PLOT_BOTTOM = 295;

export function selectedBucketIndex(length: number, index: number): number {
  if (length === 0) return -1;
  return Number.isFinite(index)
    ? Math.max(0, Math.min(length - 1, Math.trunc(index)))
    : 0;
}

// Use elapsed time, including short intervals at the edges and across DST.
export function timeScale(buckets: readonly Bucket[]) {
  const start = Date.parse(buckets[0]?.start ?? "");
  const end = Date.parse(buckets.at(-1)?.end ?? "");
  return (time: number) =>
    end > start
      ? PLOT_LEFT + ((time - start) / (end - start)) * (PLOT_RIGHT - PLOT_LEFT)
      : (PLOT_LEFT + PLOT_RIGHT) / 2;
}

export function bucketX(bucket: Bucket, x: (time: number) => number): number {
  return x((Date.parse(bucket.start) + Date.parse(bucket.end)) / 2);
}

export function measureText(measure: Measure | null | undefined): string {
  if (!measure) return "Not applicable";
  return measure.value === null
    ? `Unknown (known: ${measure.known}; unknown: ${measure.unknown})`
    : `${measure.value} (known: ${measure.known}; unknown: ${measure.unknown})`;
}

export function chartValue(measure: Measure | null | undefined): string {
  return measure?.value === null || measure === undefined || measure === null
    ? "—"
    : String(measure.value);
}

export function bucketLabel(bucket: Bucket): string {
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${format.format(new Date(bucket.start))} – ${format.format(new Date(bucket.end))}`;
}

export function bucketState(bucket: Bucket): string {
  return [
    `Quality: ${bucket.quality}`,
    bucket.partial ? "Partial" : "Full interval",
    bucket.current ? "Current" : "Historical",
    `Reasons: ${bucket.reasons.length ? bucket.reasons.join(", ") : "none"}`,
  ].join("; ");
}

export interface CountScale {
  ticks: number[];
  y: (value: number) => number;
}

// Card and transition counts use whole-number ticks, even for small ranges.
// `intervals` is the preferred tick count, not a fixed one: the ceiling is the
// least wasteful nice multiple that still covers `max`, so an axis follows its
// data instead of rounding a maximum of 45 up to a fixed four steps of 20.
function niceStep(target: number, intervals: number): number {
  const exponent = Math.floor(Math.log10(target / intervals));
  const candidates = new Set<number>();
  for (let power = exponent - 1; power <= exponent + 2; power++) {
    for (const multiplier of [1, 2, 2.5, 5]) {
      const step = multiplier * 10 ** power;
      if (Number.isSafeInteger(step) && step > 0) candidates.add(step);
    }
  }
  let step = Math.ceil(target / intervals);
  let best: { waste: number; distance: number } | null = null;
  for (const candidate of candidates) {
    const count = Math.ceil(target / candidate);
    if (count > intervals + 1) continue;
    const waste = candidate * count - target;
    const distance = Math.abs(count - intervals);
    if (
      best &&
      (waste > best.waste ||
        (waste === best.waste && distance >= best.distance))
    )
      continue;
    best = { waste, distance };
    step = candidate;
  }
  return step;
}

function scaleFrom(
  step: number,
  count: number,
  top: number,
  bottom: number,
): CountScale {
  const ceiling = step * count;
  return {
    ticks: Array.from({ length: count + 1 }, (_, index) => index * step),
    y: (value: number) => bottom - (value / ceiling) * (bottom - top),
  };
}

export function countScale(
  max: number,
  top: number,
  bottom: number,
  intervals = 4,
): CountScale {
  const target = Math.max(1, Math.ceil(max));
  const step = niceStep(target, intervals);
  return scaleFrom(step, Math.ceil(target / step), top, bottom);
}

export function ChartYAxis({
  scale,
  label,
  top,
  color,
  side = "left",
}: {
  scale: CountScale;
  label: string;
  top: number;
  color?: string;
  side?: "left" | "right";
}) {
  const right = side === "right";
  // Only one axis may own the gridlines; a second full-width set at the same
  // rows would just double every stroke. The right axis draws stubs instead.
  const edge = right ? PLOT_RIGHT : PLOT_LEFT;
  return (
    <g
      data-axis={label}
      data-side={side}
      className="text-[16px] text-muted-foreground sm:text-[10px]"
    >
      <text
        x={edge}
        y={top - 14}
        textAnchor={right ? "end" : "start"}
        fill={color ?? "currentColor"}
      >
        {label}
      </text>
      {scale.ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={right ? PLOT_RIGHT : PLOT_LEFT}
            x2={right ? PLOT_RIGHT + 4 : PLOT_RIGHT}
            y1={scale.y(tick)}
            y2={scale.y(tick)}
            stroke="currentColor"
            opacity={right ? 0.35 : 0.13}
          />
          <text
            x={right ? PLOT_RIGHT + 8 : PLOT_LEFT - 10}
            y={scale.y(tick) + 3.5}
            textAnchor={right ? "start" : "end"}
            fill="currentColor"
          >
            {tick}
          </text>
        </g>
      ))}
    </g>
  );
}

// Draw each observed value across its interval. Unknown values break the path.
export function stepPath(
  buckets: readonly Bucket[],
  values: readonly (number | null)[],
  x: (time: number) => number,
  y: (value: number) => number,
): string {
  let connected = false;
  return buckets
    .map((bucket, index) => {
      const value = values[index];
      if (value === null || value === undefined) {
        connected = false;
        return "";
      }
      const command = connected ? "L" : "M";
      connected = true;
      return `${command}${x(Date.parse(bucket.start))},${y(value)} L${x(Date.parse(bucket.end))},${y(value)}`;
    })
    .filter(Boolean)
    .join(" ");
}

// A tap wobbles by a pixel or two between press and release; under this much
// travel the gesture is a click on one bucket, not a drag over a range.
const CLICK_SLOP = 3;

export function ChartFrame({
  data,
  selectedIndex,
  onSelect,
  link,
  className,
  title,
  legend,
  bucketRead,
  children,
}: ChartFrameProps) {
  const id = useId();
  const [inspecting, setInspecting] = useState(false);
  const dragFrom = useRef<{ clientX: number; at: number } | null>(null);
  const index = selectedBucketIndex(data.buckets.length, selectedIndex);
  const selected = data.buckets[index];
  const x = timeScale(data.buckets);
  const start = Date.parse(data.buckets[0]?.start ?? "");
  const end = Date.parse(data.buckets.at(-1)?.end ?? "");
  const windowSpan: TimeSpan | null =
    data.buckets.length && end > start ? { start, end } : null;
  const dateFormat = new Intl.DateTimeFormat(
    undefined,
    end - start <= 2 * 86_400_000
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  );

  function timeAt(clientX: number, element: HTMLElement): number | null {
    const svg = element.querySelector("svg");
    if (!svg || !data.buckets.length || !Number.isFinite(clientX)) return null;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0) return null;
    const position = ((clientX - bounds.left) / bounds.width) * CHART_WIDTH;
    const ratio = Math.max(
      0,
      Math.min(1, (position - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)),
    );
    const time = start + ratio * (end - start);
    // The window is half-open, so the margin past its right edge still points
    // at the last instant inside it -- `end` itself belongs to the next day.
    return end > start ? Math.min(time, end - 1) : time;
  }

  function bucketIndexAt(time: number): number {
    const next = data.buckets.findIndex(
      (bucket) => time < Date.parse(bucket.end),
    );
    return next < 0 ? data.buckets.length - 1 : next;
  }

  function selectAt(clientX: number, element: HTMLElement): number | null {
    const time = timeAt(clientX, element);
    if (time === null) return null;
    onSelect(bucketIndexAt(time));
    setInspecting(true);
    return time;
  }

  // A drag reads a range out of the chart; it never rescales it. The window
  // stays whatever the query asked for, so both charts keep a common x axis.
  function dragSpan(clientX: number, at: number): TimeSpan | null {
    const from = dragFrom.current;
    if (!from || Math.abs(clientX - from.clientX) <= CLICK_SLOP) return null;
    const span = { start: Math.min(from.at, at), end: Math.max(from.at, at) };
    return span.start < span.end ? span : null;
  }

  // Marks live entirely inside this chart's own window: a selection or a hover
  // that misses it draws nothing at all, rather than a hint at the edge.
  const selectionBand =
    windowSpan && link?.selection
      ? spanOverlap(windowSpan, link.selection)
      : null;
  const hoverBand =
    windowSpan && link?.hover?.span
      ? spanOverlap(windowSpan, link.hover.span)
      : null;
  const hoverAt =
    windowSpan &&
    link?.hover &&
    !link.hover.span &&
    spanContains(windowSpan, link.hover.at)
      ? link.hover.at
      : null;

  return (
    <figure
      className={`min-w-0 rounded-xl border bg-card p-4 sm:p-5 [--insights-remaining:#cc7138] [--insights-completed:#248575] dark:[--insights-remaining:#edaa78] dark:[--insights-completed:#7acbb7] ${className ?? ""}`}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="font-semibold">
        {title}
      </h2>
      <ul
        aria-label={`${title} legend`}
        className="mt-3 mb-4 flex min-h-5 flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
      >
        {legend.map((entry) => (
          <li key={entry.label} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={
                entry.line
                  ? "inline-block h-0.5 w-3"
                  : "inline-block size-2 rounded-xs"
              }
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
          </li>
        ))}
      </ul>
      <fieldset
        aria-label={`${title} selection`}
        aria-describedby={`${id}-instructions ${id}-read`}
        tabIndex={data.buckets.length ? 0 : -1}
        className="relative min-w-0 rounded outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        style={{ touchAction: "pan-y" }}
        onFocus={() => setInspecting(true)}
        onBlur={() => setInspecting(false)}
        onPointerLeave={() => {
          setInspecting(false);
          link?.onHover(null);
        }}
        onKeyDown={(event) => {
          if (index < 0) return;
          let next: number;
          switch (event.key) {
            case "ArrowLeft":
            case "ArrowUp":
              next = Math.max(0, index - 1);
              break;
            case "ArrowRight":
            case "ArrowDown":
              next = Math.min(data.buckets.length - 1, index + 1);
              break;
            case "Home":
              next = 0;
              break;
            case "End":
              next = data.buckets.length - 1;
              break;
            case "Escape":
              setInspecting(false);
              // The only way back to no selection: every other gesture sets one.
              link?.onHover(null);
              link?.onSelect(null);
              return;
            default:
              return;
          }
          event.preventDefault();
          setInspecting(true);
          onSelect(next);
          // The pointer's mark would otherwise stay pinned where it was left,
          // and the inspector's own line stays suppressed behind it.
          link?.onHover(null);
        }}
        onPointerDown={(event) => {
          const at = selectAt(event.clientX, event.currentTarget);
          if (at !== null) {
            // Only the primary button drags. A right-click opens a context menu
            // and its release may never reach us, which would leave an anchor
            // armed and turn plain mouse movement into a selection.
            if (event.button === 0)
              dragFrom.current = { clientX: event.clientX, at };
            link?.onHover({ at });
          }
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          // A release swallowed by a context menu or a native drag never clears
          // the anchor, so the held button is the authority, not our own record.
          if (dragFrom.current && (event.buttons & 1) === 0)
            dragFrom.current = null;
          const at = selectAt(event.clientX, event.currentTarget);
          if (at === null) return;
          link?.onHover({ at });
          const span = dragSpan(event.clientX, at);
          if (span) link?.onSelect(span);
        }}
        onPointerUp={(event) => {
          const dragging = dragFrom.current !== null;
          if (event.currentTarget.hasPointerCapture?.(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          const at = dragging
            ? timeAt(event.clientX, event.currentTarget)
            : null;
          const span = at === null ? null : dragSpan(event.clientX, at);
          dragFrom.current = null;
          // Only a drag selects. A click keeps its existing meaning — inspect
          // this bucket — so the first click cannot strand the reader with a
          // band and no way back.
          if (span) link?.onSelect(span);
        }}
        onPointerCancel={() => {
          dragFrom.current = null;
        }}
        onClick={(event) => selectAt(event.clientX, event.currentTarget)}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (touch) selectAt(touch.clientX, event.currentTarget);
        }}
        onTouchMove={(event) => {
          const touch = event.touches[0];
          if (touch) selectAt(touch.clientX, event.currentTarget);
        }}
      >
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={title}
          className="block w-full"
          data-selected-bucket={index >= 0 ? index : undefined}
        >
          <title>{title}</title>
          {selectionBand && (
            <rect
              data-mark="selection"
              x={x(selectionBand.start)}
              y={PLOT_TOP}
              width={Math.max(0, x(selectionBand.end) - x(selectionBand.start))}
              height={PLOT_BOTTOM - PLOT_TOP}
              fill="currentColor"
              opacity={0.12}
              pointerEvents="none"
            />
          )}
          {hoverBand && (
            <rect
              data-mark="hover"
              data-hover="span"
              x={x(hoverBand.start)}
              y={PLOT_TOP}
              width={Math.max(0, x(hoverBand.end) - x(hoverBand.start))}
              height={PLOT_BOTTOM - PLOT_TOP}
              fill="currentColor"
              opacity={0.08}
              pointerEvents="none"
            />
          )}
          {hoverAt !== null && (
            <line
              data-mark="hover"
              data-hover="instant"
              x1={x(hoverAt)}
              x2={x(hoverAt)}
              y1={PLOT_TOP}
              y2={PLOT_BOTTOM}
              stroke="currentColor"
              opacity={0.45}
              pointerEvents="none"
            />
          )}
          {children}
          {/* The inspector reads the bucket's centre, the linked mark reads the
              pointer. Drawn together they are two full-height lines claiming
              two instants, so the shared one wins and the tooltip carries the
              inspected bucket on its own. Keyboard inspection raises no linked
              hover, and keeps this line. */}
          {selected && inspecting && hoverAt === null && (
            <line
              x1={bucketX(selected, x)}
              x2={bucketX(selected, x)}
              y1={PLOT_TOP}
              y2={PLOT_BOTTOM}
              stroke="currentColor"
              strokeDasharray="3 4"
              opacity={0.4}
              pointerEvents="none"
            />
          )}
          {data.buckets.length > 0 && (
            <g
              data-axis="time"
              fill="currentColor"
              className="text-[16px] text-muted-foreground sm:text-[10px]"
            >
              {Array.from({ length: 5 }, (_, tick) => {
                const time = start + ((end - start) * tick) / 4;
                return (
                  <text
                    key={time}
                    x={x(time)}
                    y={322}
                    textAnchor={
                      tick === 0 ? "start" : tick === 4 ? "end" : "middle"
                    }
                  >
                    {dateFormat.format(time)}
                  </text>
                );
              })}
            </g>
          )}
        </svg>
        {selected && inspecting && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-0 right-0 z-10 max-w-full rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          >
            <div className="text-muted-foreground">{bucketLabel(selected)}</div>
            <div className="mt-1">{bucketRead(selected, index)}</div>
          </div>
        )}
      </fieldset>
      <p id={`${id}-instructions`} className="sr-only">
        Use arrow keys, Home or End to select a time interval. Inspect by
        pointer or touch.
      </p>
      <p
        id={`${id}-read`}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {selected
          ? `${bucketLabel(selected)}; ${bucketRead(selected, index)}`
          : "No data"}
      </p>
      {data.buckets.length === 0 && (
        <p className="text-sm text-muted-foreground">No data in this range.</p>
      )}
    </figure>
  );
}
