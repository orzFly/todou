import type { Bucket, BurnResponse, Measure } from "@todou/shared";
import { type ReactNode, useId, useState } from "react";

export interface InsightsSelectionProps {
  selectedIndex: number;
  onSelect: (index: number) => void;
}

export interface InsightsBucketProps extends InsightsSelectionProps {
  data: BurnResponse;
  className?: string;
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
export const PLOT_RIGHT = 531;
export const PLOT_TOP = 30;
export const PLOT_BOTTOM = 295;
export const STOCK_BOTTOM = 182;
export const FLOW_TOP = 226;

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
export function countScale(
  max: number,
  top: number,
  bottom: number,
  intervals = 4,
): CountScale {
  const roughStep = Math.max(1, max / intervals);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const step = Math.ceil(
    ([1, 2, 2.5, 5, 10].find((value) => value * magnitude >= roughStep) ?? 10) *
      magnitude,
  );
  const ceiling = step * intervals;
  return {
    ticks: Array.from({ length: intervals + 1 }, (_, index) => index * step),
    y: (value: number) => bottom - (value / ceiling) * (bottom - top),
  };
}

export function ChartYAxis({
  scale,
  label,
  top,
  color,
}: {
  scale: CountScale;
  label: string;
  top: number;
  color?: string;
}) {
  return (
    <g
      data-axis={label}
      className="text-[16px] text-muted-foreground sm:text-[10px]"
    >
      <text x={PLOT_LEFT} y={top - 14} fill={color ?? "currentColor"}>
        {label}
      </text>
      {scale.ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PLOT_LEFT}
            x2={PLOT_RIGHT}
            y1={scale.y(tick)}
            y2={scale.y(tick)}
            stroke="currentColor"
            opacity={0.13}
          />
          <text
            x={PLOT_LEFT - 10}
            y={scale.y(tick) + 3.5}
            textAnchor="end"
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

export function ChartFrame({
  data,
  selectedIndex,
  onSelect,
  className,
  title,
  legend,
  bucketRead,
  children,
}: ChartFrameProps) {
  const id = useId();
  const [inspecting, setInspecting] = useState(false);
  const index = selectedBucketIndex(data.buckets.length, selectedIndex);
  const selected = data.buckets[index];
  const x = timeScale(data.buckets);
  const start = Date.parse(data.buckets[0]?.start ?? "");
  const end = Date.parse(data.buckets.at(-1)?.end ?? "");
  const dateFormat = new Intl.DateTimeFormat(
    undefined,
    end - start <= 2 * 86_400_000
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  );

  function selectAt(clientX: number, element: HTMLElement) {
    const svg = element.querySelector("svg");
    if (!svg || !data.buckets.length || !Number.isFinite(clientX)) return;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const position = ((clientX - bounds.left) / bounds.width) * CHART_WIDTH;
    const ratio = Math.max(
      0,
      Math.min(1, (position - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)),
    );
    const time = start + ratio * (end - start);
    const next = data.buckets.findIndex(
      (bucket) => time < Date.parse(bucket.end),
    );
    onSelect(next < 0 ? data.buckets.length - 1 : next);
    setInspecting(true);
  }

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
        onPointerLeave={() => setInspecting(false)}
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
              return;
            default:
              return;
          }
          event.preventDefault();
          setInspecting(true);
          onSelect(next);
        }}
        onPointerDown={(event) => {
          selectAt(event.clientX, event.currentTarget);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => selectAt(event.clientX, event.currentTarget)}
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
          {children}
          {selected && inspecting && (
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
