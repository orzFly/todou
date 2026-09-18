import {
  bucketLabel,
  bucketState,
  type InsightsBucketProps,
  measureText,
  selectedBucketIndex,
} from "./chart-frame.tsx";

export function BucketTable({
  data,
  selectedIndex,
  onSelect,
  className,
}: InsightsBucketProps) {
  const index = selectedBucketIndex(data.buckets.length, selectedIndex);

  return (
    <div className={`overflow-x-auto rounded-lg border ${className ?? ""}`}>
      <table className="w-full text-left text-sm" aria-label="Insights buckets">
        <caption className="p-3 text-left font-medium">
          All buckets — exact stock and flow measures
        </caption>
        <thead>
          <tr>
            {[
              "Bucket",
              "State",
              "Remaining stock",
              "Scope stock",
              "Open stock",
              "Completed flow",
              "Completed cards",
              "Reopened flow",
              "Scope added",
              "Scope removed",
              "Category closed",
              "Category reopened",
              "Unknown cards",
            ].map((label) => (
              <th
                key={label}
                scope="col"
                className="whitespace-nowrap border-b p-3"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.buckets.map((bucket, bucketIndex) => (
            <tr
              key={bucket.start}
              data-bucket-index={bucketIndex}
              data-selected={bucketIndex === index}
              className={bucketIndex === index ? "bg-muted" : undefined}
            >
              <th scope="row" className="border-b p-3">
                <button
                  type="button"
                  aria-label={`Select bucket ${bucketIndex + 1}: ${bucketLabel(bucket)}`}
                  aria-pressed={bucketIndex === index}
                  onClick={() => onSelect(bucketIndex)}
                  className="whitespace-nowrap rounded px-2 py-1 text-left underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {bucketLabel(bucket)}
                </button>
              </th>
              <td className="border-b p-3">{bucketState(bucket)}</td>
              <td data-measure="stock.remaining" className="border-b p-3">
                {measureText(bucket.stock?.remaining)}
              </td>
              <td data-measure="stock.scope" className="border-b p-3">
                {measureText(bucket.stock?.scope)}
              </td>
              <td data-measure="stock.open_total" className="border-b p-3">
                {measureText(bucket.stock?.open_total)}
              </td>
              {(
                [
                  "completed",
                  "completed_cards",
                  "reopened",
                  "scope_added",
                  "scope_removed",
                  "category_closed",
                  "category_reopened",
                ] as const
              ).map((key) => (
                <td
                  key={key}
                  data-measure={`flow.${key}`}
                  className="border-b p-3"
                >
                  {measureText(bucket.flow?.[key])}
                </td>
              ))}
              <td data-measure="stock.unknown_cards" className="border-b p-3">
                {bucket.stock ? bucket.stock.unknown_cards : "Not applicable"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.buckets.length === 0 && (
        <p className="p-3 text-sm text-muted-foreground">
          No buckets in this range.
        </p>
      )}
    </div>
  );
}
