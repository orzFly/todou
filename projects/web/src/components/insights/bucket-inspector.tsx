import type { Flow } from "@todou/shared";
import {
  bucketLabel,
  type InsightsBucketProps,
  measureText,
  selectedBucketIndex,
} from "./chart-frame.tsx";

export const FLOW_MEASURES = [
  ["completed", "Completed"],
  ["completed_cards", "Completed cards"],
  ["reopened", "Reopened"],
  ["created_remaining", "Created remaining"],
  ["created_completed", "Created completed"],
  ["moved_in_remaining", "Moved in remaining"],
  ["moved_in_completed", "Moved in completed"],
  ["restored_remaining", "Restored remaining"],
  ["restored_completed", "Restored completed"],
  ["reintroduced_remaining", "Reintroduced remaining"],
  ["reintroduced_completed", "Reintroduced completed"],
  ["excluded_remaining", "Excluded remaining"],
  ["excluded_completed", "Excluded completed"],
  ["deleted_remaining", "Deleted remaining"],
  ["deleted_completed", "Deleted completed"],
  ["scope_added", "Scope added"],
  ["scope_removed", "Scope removed"],
  ["open_entered", "Open entered"],
  ["open_exited", "Open exited"],
  ["category_closed", "Category closed"],
  ["category_reopened", "Category reopened"],
  ["created_open", "Created open"],
  ["moved_in_open", "Moved in open"],
  ["restored_open", "Restored open"],
  ["deleted_open", "Deleted open"],
] as const satisfies ReadonlyArray<
  readonly [Exclude<keyof Flow, "closed_by_status">, string]
>;

export function BucketInspector({
  data,
  selectedIndex,
  className,
}: InsightsBucketProps) {
  const index = selectedBucketIndex(data.buckets.length, selectedIndex);
  const bucket = data.buckets[index];
  const statusName = new Map(
    data.statuses.map((status) => [status.status_id, status.name]),
  );

  return (
    <section
      aria-label="Bucket inspector"
      className={`rounded-lg border p-4 ${className ?? ""}`}
    >
      <div aria-live="polite" aria-atomic="true">
        <h2 className="font-medium">
          {bucket ? `Bucket ${index + 1}` : "Bucket inspector"}
        </h2>
        {bucket && (
          <p className="text-sm text-muted-foreground">{bucketLabel(bucket)}</p>
        )}
      </div>
      {!bucket ? (
        <p>No bucket selected.</p>
      ) : (
        <div data-bucket-index={index}>
          <dl className="my-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt>Quality</dt>
              <dd data-measure="quality">{bucket.quality}</dd>
            </div>
            <div>
              <dt>Partial</dt>
              <dd>{bucket.partial ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Current</dt>
              <dd>{bucket.current ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt>Reasons</dt>
              <dd>
                {bucket.reasons.length ? bucket.reasons.join(", ") : "None"}
              </dd>
            </div>
          </dl>
          {bucket.quality === "not_applicable" && (
            <p>
              Not applicable: this bucket is before project creation and has no
              stock or flow snapshot.
            </p>
          )}
          {bucket.partial && (
            <p className="text-sm text-muted-foreground">
              Partial bucket: only part of the bucket interval is covered.
            </p>
          )}
          {bucket.current && (
            <p className="text-sm text-muted-foreground">
              Current bucket: values are recorded as of {data.as_of}; this
              interval is not yet complete.
            </p>
          )}
          <h3 className="mt-4 font-medium">Stock at bucket end</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {(
              [
                ["remaining", "Remaining"],
                ["scope", "Scope"],
                ["open_total", "Open total"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd data-measure={`stock.${key}`}>
                  {measureText(bucket.stock?.[key])}
                </dd>
              </div>
            ))}
            <div>
              <dt>Unknown cards</dt>
              <dd data-measure="stock.unknown_cards">
                {bucket.stock ? bucket.stock.unknown_cards : "Not applicable"}
              </dd>
            </div>
            {bucket.stock?.by_status.map((entry) => (
              <div key={entry.status_id}>
                <dt>{`Stock: ${statusName.get(entry.status_id) ?? `Status ${entry.status_id}`}`}</dt>
                <dd data-measure={`stock.by_status.${entry.status_id}`}>
                  {entry.count}
                </dd>
              </div>
            ))}
          </dl>
          <h3 className="mt-4 font-medium">Flow within bucket</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {FLOW_MEASURES.map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd data-measure={`flow.${key}`}>
                  {measureText(bucket.flow?.[key])}
                </dd>
              </div>
            ))}
            {bucket.flow?.closed_by_status.map((entry) => (
              <div key={entry.status_id}>
                <dt>{`Closed by status: ${statusName.get(entry.status_id) ?? `Status ${entry.status_id}`}`}</dt>
                <dd data-measure={`flow.closed_by_status.${entry.status_id}`}>
                  {measureText(entry.count)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
