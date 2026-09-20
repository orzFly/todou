import type { Bucket } from "@todou/shared";
import {
  bucketX,
  ChartFrame,
  ChartYAxis,
  chartValue,
  countScale,
  type InsightsBucketProps,
  PLOT_BOTTOM,
  PLOT_TOP,
  stepPath,
  timeScale,
} from "./chart-frame.tsx";

const legend = [
  { label: "Remaining", color: "var(--insights-remaining)", line: true },
  { label: "Completed", color: "var(--insights-completed)" },
];

export function burnBucketRead(bucket: Bucket): string {
  return `Remaining: ${chartValue(bucket.stock?.remaining)} · Completed: ${chartValue(bucket.flow?.completed)}`;
}

export function BurnChart(props: InsightsBucketProps) {
  const { buckets } = props.data;
  const remaining = buckets.map(
    (bucket) => bucket.stock?.remaining.value ?? null,
  );
  // Completion is its own flow, never a remaining-stock delta.
  const completed = buckets.map(
    (bucket) => bucket.flow?.completed.value ?? null,
  );
  // Both series share the plot area and the x axis, reading off opposite edges.
  // The two y axes stay independent on purpose: a surge in one measure must not
  // silently rescale the other series under a reader comparing them over time.
  const stockScale = countScale(
    Math.max(0, ...remaining.map((value) => value ?? 0)),
    PLOT_TOP,
    PLOT_BOTTOM,
  );
  const flowScale = countScale(
    Math.max(0, ...completed.map((value) => value ?? 0)),
    PLOT_TOP,
    PLOT_BOTTOM,
  );
  const x = timeScale(buckets);

  return (
    <ChartFrame
      {...props}
      title="Burn chart"
      legend={legend}
      bucketRead={burnBucketRead}
    >
      <ChartYAxis
        scale={stockScale}
        label="Remaining"
        top={PLOT_TOP}
        color={legend[0]?.color}
      />
      <ChartYAxis
        scale={flowScale}
        label="Completed"
        top={PLOT_TOP}
        side="right"
        color={legend[1]?.color}
      />
      {buckets.map((bucket, index) => {
        const value = completed[index];
        if (value === null || value === undefined) return null;
        const width =
          (x(Date.parse(bucket.end)) - x(Date.parse(bucket.start))) * 0.57;
        return (
          <rect
            key={bucket.start}
            data-series="completed"
            data-bucket-index={index}
            data-value={value}
            x={bucketX(bucket, x) - width / 2}
            y={flowScale.y(value)}
            width={width}
            height={PLOT_BOTTOM - flowScale.y(value)}
            rx={Math.min(1, width / 2)}
            fill={legend[1]?.color}
            opacity={0.78}
          />
        );
      })}
      <path
        data-series="remaining"
        d={stepPath(buckets, remaining, x, stockScale.y)}
        stroke={legend[0]?.color}
        strokeWidth={2.4}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        fill="none"
      />
      {buckets.map((bucket, index) => {
        const value = remaining[index];
        if (value === null || value === undefined) return null;
        return (
          <circle
            key={bucket.start}
            data-series="remaining-point"
            data-bucket-index={index}
            data-value={value}
            cx={bucketX(bucket, x)}
            cy={stockScale.y(value)}
            r={index === props.selectedIndex ? 3 : 0}
            fill={legend[0]?.color}
          />
        );
      })}
    </ChartFrame>
  );
}
