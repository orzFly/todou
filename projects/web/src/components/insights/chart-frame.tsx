import type { Bucket, BurnResponse, Measure } from "@todou/shared";
import { type ReactNode, useId } from "react";

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
}

export interface ChartFrameProps extends InsightsBucketProps {
  title: string;
  description: string;
  legend: readonly ChartLegendEntry[];
  bucketRead: (bucket: Bucket, index: number) => string;
  children: ReactNode;
}

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 320;
export const PLOT_LEFT = 48;
export const PLOT_RIGHT = 700;
export const PLOT_TOP = 20;
export const PLOT_BOTTOM = 280;

export function selectedBucketIndex(length: number, index: number): number {
  if (length === 0) return -1;
  return Number.isFinite(index)
    ? Math.max(0, Math.min(length - 1, Math.trunc(index)))
    : 0;
}

export function bucketX(index: number, length: number): number {
  return length <= 1
    ? (PLOT_LEFT + PLOT_RIGHT) / 2
    : PLOT_LEFT + (index / (length - 1)) * (PLOT_RIGHT - PLOT_LEFT);
}

export function measureText(measure: Measure | null | undefined): string {
  if (!measure) return "Not applicable";
  return measure.value === null
    ? `Unknown (known: ${measure.known}; unknown: ${measure.unknown})`
    : `${measure.value} (known: ${measure.known}; unknown: ${measure.unknown})`;
}

export function bucketLabel(bucket: Bucket): string {
  return `${bucket.start} – ${bucket.end}`;
}

export function bucketState(bucket: Bucket): string {
  return [
    `Quality: ${bucket.quality}`,
    bucket.partial ? "Partial" : "Full bucket",
    bucket.current ? "Current" : "Historical",
    `Reasons: ${bucket.reasons.length ? bucket.reasons.join(", ") : "none"}`,
  ].join("; ");
}

// Each unknown terminates the path. A later exact value starts a new segment.
export function linePath(
  values: readonly (number | null)[],
  y: (value: number) => number,
): string {
  let connected = false;
  return values
    .map((value, index) => {
      if (value === null) {
        connected = false;
        return "";
      }
      const command = connected ? "L" : "M";
      connected = true;
      return `${command}${bucketX(index, values.length)},${y(value)}`;
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
  description,
  legend,
  bucketRead,
  children,
}: ChartFrameProps) {
  const id = useId();
  const index = selectedBucketIndex(data.buckets.length, selectedIndex);
  const selected = data.buckets[index];

  function selectAt(clientX: number, element: HTMLElement) {
    const svg = element.querySelector("svg");
    if (!svg || !data.buckets.length || !Number.isFinite(clientX)) return;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const x = ((clientX - bounds.left) / bounds.width) * CHART_WIDTH;
    const ratio = Math.max(
      0,
      Math.min(1, (x - PLOT_LEFT) / (PLOT_RIGHT - PLOT_LEFT)),
    );
    onSelect(Math.round(ratio * (data.buckets.length - 1)));
  }

  return (
    <figure
      className={`rounded-lg border p-4 ${className ?? ""}`}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`} className="font-medium">
        {title}
      </h2>
      <p id={`${id}-description`} className="text-sm text-muted-foreground">
        {description}
      </p>
      <ul
        aria-label={`${title} legend`}
        className="my-3 flex flex-wrap gap-4 text-sm"
      >
        {legend.map((entry) => (
          <li key={entry.label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-block size-3 rounded-sm"
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
          </li>
        ))}
      </ul>
      <fieldset
        aria-label={`${title} bucket selection`}
        aria-describedby={`${id}-description ${id}-instructions ${id}-read`}
        tabIndex={data.buckets.length ? 0 : -1}
        className="rounded outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        style={{ touchAction: "pan-y" }}
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
            default:
              return;
          }
          event.preventDefault();
          onSelect(next);
        }}
        onPointerDown={(event) => {
          selectAt(event.clientX, event.currentTarget);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.buttons > 0) selectAt(event.clientX, event.currentTarget);
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
          {index >= 0 && (
            <rect
              x={bucketX(index, data.buckets.length) - 5}
              y={PLOT_TOP}
              width={10}
              height={PLOT_BOTTOM - PLOT_TOP}
              fill="currentColor"
              opacity={0.08}
            />
          )}
          {children}
          {data.buckets.length > 0 && (
            <>
              <text x={PLOT_LEFT} y={310} fontSize={10} fill="currentColor">
                {data.buckets[0]?.start}
              </text>
              <text
                x={PLOT_RIGHT}
                y={310}
                textAnchor="end"
                fontSize={10}
                fill="currentColor"
              >
                {data.buckets[data.buckets.length - 1]?.end}
              </text>
            </>
          )}
        </svg>
      </fieldset>
      <p id={`${id}-instructions`} className="sr-only">
        Use arrow keys, Home or End to select a bucket. Select a bucket by
        pointer or touch.
      </p>
      <p
        id={`${id}-read`}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {selected
          ? `Bucket ${index + 1}: ${bucketLabel(selected)}; ${bucketRead(selected, index)}; ${bucketState(selected)}`
          : "No buckets"}
      </p>
      {data.buckets.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No buckets in this range.
        </p>
      )}
    </figure>
  );
}
