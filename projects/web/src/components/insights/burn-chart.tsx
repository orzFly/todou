import type { Bucket } from "@todou/shared";
import {
  bucketLabel,
  bucketX,
  ChartFrame,
  type InsightsBucketProps,
  linePath,
  measureText,
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
} from "./chart-frame.tsx";

const legend = [
  { label: "Remaining (stock)", color: "#2563eb" },
  { label: "Scope (stock)", color: "#7c3aed" },
  { label: "Completed (flow)", color: "#16a34a" },
];

export function burnBucketRead(bucket: Bucket): string {
  return [
    `Remaining: ${measureText(bucket.stock?.remaining)}`,
    `Scope: ${measureText(bucket.stock?.scope)}`,
    `Completed: ${measureText(bucket.flow?.completed)}`,
  ].join("; ");
}

export function BurnChart(props: InsightsBucketProps) {
  const { buckets } = props.data;
  const remaining = buckets.map(
    (bucket) => bucket.stock?.remaining.value ?? null,
  );
  const scope = buckets.map((bucket) => bucket.stock?.scope.value ?? null);
  // Never infer completion from a stock delta: scope changes and reopening are independent flows.
  const completed = buckets.map(
    (bucket) => bucket.flow?.completed.value ?? null,
  );
  const max = Math.max(
    1,
    ...remaining.map((value) => value ?? 0),
    ...scope.map((value) => value ?? 0),
    ...completed.map((value) => value ?? 0),
  );
  const y = (value: number) =>
    PLOT_BOTTOM - (value / max) * (PLOT_BOTTOM - PLOT_TOP);
  const barWidth = Math.min(
    20,
    (PLOT_RIGHT - PLOT_LEFT) / Math.max(1, buckets.length) / 2,
  );
  const hasExact = [...remaining, ...scope, ...completed].some(
    (value) => value !== null,
  );

  return (
    <ChartFrame
      {...props}
      title="Burn chart"
      description="Stocks at bucket end; completed flow within each bucket. Unknown values are gaps."
      legend={legend}
      bucketRead={burnBucketRead}
    >
      <g stroke="currentColor" opacity={0.2}>
        <line
          x1={PLOT_LEFT}
          y1={PLOT_BOTTOM}
          x2={PLOT_RIGHT}
          y2={PLOT_BOTTOM}
        />
        <line x1={PLOT_LEFT} y1={PLOT_TOP} x2={PLOT_LEFT} y2={PLOT_BOTTOM} />
      </g>
      <g fill="currentColor" fontSize={11}>
        <text x={PLOT_LEFT - 8} y={PLOT_TOP + 4} textAnchor="end">
          {max}
        </text>
        <text x={PLOT_LEFT - 8} y={PLOT_BOTTOM + 4} textAnchor="end">
          0
        </text>
      </g>
      {completed.map((value, index) =>
        value === null ? null : (
          <rect
            key={buckets[index]?.start}
            data-series="completed"
            data-bucket-index={index}
            data-value={value}
            x={bucketX(index, buckets.length) - barWidth / 2}
            y={y(value)}
            width={barWidth}
            height={PLOT_BOTTOM - y(value)}
            fill={legend[2]?.color}
            opacity={0.5}
          >
            <title>{`Bucket ${index + 1}: Completed: ${measureText(buckets[index]?.flow?.completed)}`}</title>
          </rect>
        ),
      )}
      {[
        {
          name: "remaining",
          values: remaining,
          color: legend[0]?.color,
          label: "Remaining",
        },
        {
          name: "scope",
          values: scope,
          color: legend[1]?.color,
          label: "Scope",
        },
      ].map((series) => (
        <g key={series.name}>
          <path
            data-series={series.name}
            d={linePath(series.values, y)}
            stroke={series.color}
            strokeWidth={2}
            strokeDasharray={series.name === "scope" ? "6 4" : undefined}
            fill="none"
          />
          {series.values.map((value, index) =>
            value === null ? null : (
              <circle
                key={buckets[index]?.start}
                data-series={`${series.name}-point`}
                data-bucket-index={index}
                data-value={value}
                cx={bucketX(index, buckets.length)}
                cy={y(value)}
                r={3}
                fill={series.color}
              >
                <title>{`Bucket ${index + 1}: ${series.label}: ${measureText(series.name === "remaining" ? buckets[index]?.stock?.remaining : buckets[index]?.stock?.scope)}`}</title>
              </circle>
            ),
          )}
        </g>
      ))}
      {buckets.map((bucket, index) => {
        if (
          remaining[index] !== null &&
          scope[index] !== null &&
          completed[index] !== null
        )
          return null;
        return (
          <g key={bucket.start} data-unknown-bucket={index}>
            <title>{`${bucketLabel(bucket)}; ${burnBucketRead(bucket)}`}</title>
            <text
              x={bucketX(index, buckets.length)}
              y={PLOT_BOTTOM + 16}
              textAnchor="middle"
              fontSize={12}
              fill="currentColor"
            >
              ?
            </text>
          </g>
        );
      })}
      {buckets.length > 0 && !hasExact && (
        <text
          x={(PLOT_LEFT + PLOT_RIGHT) / 2}
          y={150}
          textAnchor="middle"
          fill="currentColor"
        >
          No exact values
        </text>
      )}
    </ChartFrame>
  );
}
