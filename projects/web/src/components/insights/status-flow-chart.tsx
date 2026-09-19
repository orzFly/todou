import { type Bucket, enumValue, type RoleEntry } from "@todou/shared";
import {
  ChartFrame,
  ChartYAxis,
  countScale,
  type InsightsBucketProps,
  PLOT_BOTTOM,
  PLOT_TOP,
  timeScale,
} from "./chart-frame.tsx";

function compositionPath(
  buckets: readonly Bucket[],
  bands: readonly ([number, number] | null)[],
  x: (time: number) => number,
  y: (value: number) => number,
): string {
  const paths: string[] = [];
  let upper: string[] = [];
  let lower: string[] = [];
  function finish() {
    if (upper.length)
      paths.push(`${upper.join(" ")} ${lower.reverse().join(" ")} Z`);
    upper = [];
    lower = [];
  }
  buckets.forEach((bucket, index) => {
    const band = bands[index];
    if (!band) {
      finish();
      return;
    }
    const left = x(Date.parse(bucket.start));
    const right = x(Date.parse(bucket.end));
    upper.push(
      `${upper.length ? "L" : "M"}${left},${y(band[1])} L${right},${y(band[1])}`,
    );
    lower.push(`L${right},${y(band[0])} L${left},${y(band[0])}`);
  });
  finish();
  return paths.join(" ");
}

export function statusFlowBucketRead(
  bucket: Bucket,
  statuses: readonly RoleEntry[],
): string {
  return statuses
    .filter(
      (status) => enumValue(status.category, "status category") === "open",
    )
    .map((status) => {
      const value =
        !bucket.stock ||
        bucket.stock.open_total.value === null ||
        bucket.stock.unknown_cards > 0
          ? "—"
          : (bucket.stock.by_status.find(
              (entry) => entry.status_id === status.status_id,
            )?.count ?? 0);
      return `${status.name}: ${value}`;
    })
    .join(" · ");
}

export function StatusFlowChart(props: InsightsBucketProps) {
  const { buckets, statuses } = props.data;
  // Actual status category defines this chart independently of configured burn roles.
  const open = statuses
    .filter(
      (status) => enumValue(status.category, "status category") === "open",
    )
    .sort((a, b) => a.position - b.position || a.status_id - b.status_id);
  const counts = buckets.map((bucket) => {
    if (
      !bucket.stock ||
      bucket.stock.open_total.value === null ||
      bucket.stock.unknown_cards > 0
    )
      return null;
    return open.map(
      (status) =>
        bucket.stock?.by_status.find(
          (entry) => entry.status_id === status.status_id,
        )?.count ?? 0,
    );
  });
  const scale = countScale(
    Math.max(
      0,
      ...counts.map(
        (values) => values?.reduce((sum, count) => sum + count, 0) ?? 0,
      ),
    ),
    PLOT_TOP,
    PLOT_BOTTOM,
  );
  const x = timeScale(buckets);

  return (
    <ChartFrame
      {...props}
      title="Status flow chart"
      legend={open.map((status) => ({
        label: status.name,
        color: status.color,
      }))}
      bucketRead={(bucket) => statusFlowBucketRead(bucket, open)}
    >
      <ChartYAxis scale={scale} label="Open" top={PLOT_TOP} />
      {open.map((status, statusIndex) => {
        const bands = counts.map((values): [number, number] | null => {
          if (!values) return null;
          const lower = values
            .slice(0, statusIndex)
            .reduce((sum, count) => sum + count, 0);
          return [lower, lower + (values[statusIndex] ?? 0)];
        });
        return (
          <path
            key={status.status_id}
            data-series="open-stock"
            data-status-id={status.status_id}
            d={compositionPath(buckets, bands, x, scale.y)}
            fill={status.color}
            fillOpacity={0.75}
            stroke="var(--card)"
            strokeWidth={0.5}
            strokeLinejoin="round"
          />
        );
      })}
    </ChartFrame>
  );
}
