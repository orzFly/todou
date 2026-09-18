import type { Bucket, RoleEntry } from "@todou/shared";
import {
  bucketX,
  ChartFrame,
  type InsightsBucketProps,
  measureText,
  PLOT_LEFT,
  PLOT_RIGHT,
} from "./chart-frame.tsx";

function compositionPath(
  bands: readonly ([number, number] | null)[],
  y: (value: number) => number,
): string {
  const paths: string[] = [];
  let segment: number[] = [];
  function finish() {
    if (segment.length === 0) return;
    const first = segment[0];
    if (segment.length === 1 && first !== undefined) {
      const band = bands[first];
      if (band) {
        const x = bucketX(first, bands.length);
        paths.push(
          `M${x - 4},${y(band[1])} L${x + 4},${y(band[1])} L${x + 4},${y(band[0])} L${x - 4},${y(band[0])} Z`,
        );
      }
    } else {
      const upper = segment.map(
        (index, offset) =>
          `${offset ? "L" : "M"}${bucketX(index, bands.length)},${y(bands[index]?.[1] ?? 0)}`,
      );
      const lower = [...segment]
        .reverse()
        .map(
          (index) =>
            `L${bucketX(index, bands.length)},${y(bands[index]?.[0] ?? 0)}`,
        );
      paths.push(`${upper.join(" ")} ${lower.join(" ")} Z`);
    }
    segment = [];
  }
  bands.forEach((band, index) => {
    if (band === null) finish();
    else segment.push(index);
  });
  finish();
  return paths.join(" ");
}

export function statusFlowBucketRead(
  bucket: Bucket,
  statuses: readonly RoleEntry[],
): string {
  const open = statuses.filter((status) => status.category !== "closed");
  const closed = statuses.filter((status) => status.category === "closed");
  return [
    `Open total: ${measureText(bucket.stock?.open_total)}`,
    `Unknown cards: ${bucket.stock ? bucket.stock.unknown_cards : "Not applicable"}`,
    ...open.map(
      (status) =>
        `Open stock, ${status.name}: ${bucket.stock ? (bucket.stock.by_status.find((entry) => entry.status_id === status.status_id)?.count ?? 0) : "Not applicable"}`,
    ),
    ...closed.map((status) => {
      const count = bucket.flow?.closed_by_status.find(
        (entry) => entry.status_id === status.status_id,
      )?.count;
      return `Closed flow, ${status.name}: ${bucket.flow ? measureText(count ?? { value: 0, known: 0, unknown: 0 }) : "Not applicable"}`;
    }),
  ].join("; ");
}

export function StatusFlowChart(props: InsightsBucketProps) {
  const { buckets, statuses } = props.data;
  // Category, not the configurable burn role, defines both panels.
  const ordered = [...statuses].sort(
    (a, b) => a.position - b.position || a.status_id - b.status_id,
  );
  const open = ordered.filter((status) => status.category !== "closed");
  const closed = ordered.filter((status) => status.category === "closed");
  const openCounts = buckets.map((bucket) => {
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
  const closedCounts = buckets.map((bucket) => {
    if (!bucket.flow) return null;
    const counts = closed.map((status) => {
      const measure = bucket.flow?.closed_by_status.find(
        (entry) => entry.status_id === status.status_id,
      )?.count;
      return measure ? measure.value : 0;
    });
    // An unknown segment makes the whole stacked height unknown, not zero.
    if (counts.some((count) => count === null)) return null;
    return counts as number[];
  });
  const openMax = Math.max(
    1,
    ...openCounts.map(
      (counts) => counts?.reduce((sum, count) => sum + count, 0) ?? 0,
    ),
  );
  const closedMax = Math.max(
    1,
    ...closedCounts.map(
      (counts) => counts?.reduce((sum, count) => sum + count, 0) ?? 0,
    ),
  );
  const openY = (value: number) => 150 - (value / openMax) * 112;
  const closedY = (value: number) => 280 - (value / closedMax) * 88;
  const barWidth = Math.min(
    24,
    (PLOT_RIGHT - PLOT_LEFT) / Math.max(1, buckets.length) / 2,
  );

  return (
    <ChartFrame
      {...props}
      title="Status flow chart"
      description="Open stock by status category at bucket end; closed-category flow within each bucket. Unknown compositions are gaps."
      legend={[
        ...open.map((status) => ({
          label: `Open stock: ${status.name}`,
          color: status.color,
        })),
        ...closed.map((status) => ({
          label: `Closed flow: ${status.name}`,
          color: status.color,
        })),
      ]}
      bucketRead={(bucket) => statusFlowBucketRead(bucket, ordered)}
    >
      <g fill="currentColor" fontSize={11}>
        <text x={PLOT_LEFT} y={24}>
          Open stock
        </text>
        <text x={PLOT_LEFT - 8} y={42} textAnchor="end">
          {openMax}
        </text>
        <text x={PLOT_LEFT - 8} y={154} textAnchor="end">
          0
        </text>
        <text x={PLOT_LEFT} y={176}>
          Closed flow
        </text>
        <text x={PLOT_LEFT - 8} y={196} textAnchor="end">
          {closedMax}
        </text>
        <text x={PLOT_LEFT - 8} y={284} textAnchor="end">
          0
        </text>
      </g>
      <g stroke="currentColor" opacity={0.2}>
        <line x1={PLOT_LEFT} y1={150} x2={PLOT_RIGHT} y2={150} />
        <line x1={PLOT_LEFT} y1={280} x2={PLOT_RIGHT} y2={280} />
      </g>
      {open.map((status, statusIndex) => {
        const bands = openCounts.map((counts): [number, number] | null => {
          if (!counts) return null;
          const lower = counts
            .slice(0, statusIndex)
            .reduce((sum, count) => sum + count, 0);
          return [lower, lower + (counts[statusIndex] ?? 0)];
        });
        return (
          <g key={status.status_id}>
            <path
              data-series="open-stock"
              data-status-id={status.status_id}
              d={compositionPath(bands, openY)}
              fill={status.color}
              fillOpacity={0.6}
              stroke={status.color}
            >
              <title>{`Open stock: ${status.name}`}</title>
            </path>
            {openCounts.map((counts, index) =>
              counts ? (
                <circle
                  key={buckets[index]?.start}
                  data-series="open-stock-point"
                  data-status-id={status.status_id}
                  data-bucket-index={index}
                  data-value={counts[statusIndex] ?? 0}
                  cx={bucketX(index, buckets.length)}
                  cy={openY(
                    counts
                      .slice(0, statusIndex + 1)
                      .reduce((sum, count) => sum + count, 0),
                  )}
                  r={2}
                  fill={status.color}
                >
                  <title>{`Bucket ${index + 1}: Open stock, ${status.name}: ${counts[statusIndex] ?? 0}`}</title>
                </circle>
              ) : null,
            )}
          </g>
        );
      })}
      {closedCounts.map((counts, index) =>
        counts
          ? closed.map((status, statusIndex) => {
              const lower = counts
                .slice(0, statusIndex)
                .reduce((sum, count) => sum + count, 0);
              const count = counts[statusIndex] ?? 0;
              const measure = buckets[index]?.flow?.closed_by_status.find(
                (entry) => entry.status_id === status.status_id,
              )?.count;
              return (
                <rect
                  key={`${buckets[index]?.start}-${status.status_id}`}
                  data-series="closed-flow"
                  data-status-id={status.status_id}
                  data-bucket-index={index}
                  data-value={count}
                  x={bucketX(index, buckets.length) - barWidth / 2}
                  y={closedY(lower + count)}
                  width={barWidth}
                  height={closedY(lower) - closedY(lower + count)}
                  fill={status.color}
                >
                  <title>{`Bucket ${index + 1}: Closed flow, ${status.name}: ${measureText(measure ?? { value: 0, known: 0, unknown: 0 })}`}</title>
                </rect>
              );
            })
          : null,
      )}
      {buckets.map((bucket, index) => (
        <g key={bucket.start}>
          {openCounts[index] === null && (
            <text
              data-unknown-open-bucket={index}
              x={bucketX(index, buckets.length)}
              y={146}
              textAnchor="middle"
              fill="currentColor"
            >
              <title>{statusFlowBucketRead(bucket, ordered)}</title>?
            </text>
          )}
          {closedCounts[index] === null && (
            <text
              data-unknown-closed-bucket={index}
              x={bucketX(index, buckets.length)}
              y={276}
              textAnchor="middle"
              fill="currentColor"
            >
              <title>{statusFlowBucketRead(bucket, ordered)}</title>?
            </text>
          )}
        </g>
      ))}
    </ChartFrame>
  );
}
