import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { BurnResponse } from "@todou/shared";
import { Grain } from "@todou/shared";
import { useState } from "react";
import { insightsBurnQuery, insightsSettingsQuery } from "@/api/insights.ts";
import { BucketInspector } from "@/components/insights/bucket-inspector.tsx";
import { BucketTable } from "@/components/insights/bucket-table.tsx";
import { BurnChart } from "@/components/insights/burn-chart.tsx";
import { StatusFlowChart } from "@/components/insights/status-flow-chart.tsx";
import { PageSkeleton } from "@/components/page-skeleton.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { Button } from "@/components/ui/button";
import type {
  InsightsSearch,
  InsightsSearchContext,
  ResolvedInsightsSearch,
} from "@/lib/insights-search.ts";
import {
  INSIGHTS_PRESETS,
  insightsPresetRequest,
  insightsRequest,
  resolveInsightsSearch,
} from "@/lib/insights-search.ts";

export function InsightsPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const search = useSearch({ from: "/authed/projects/$slug/insights" });
  const navigate = useNavigate();
  const [context] = useState<InsightsSearchContext>(() => ({
    now: new Date(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
  }));
  const resolved = resolveInsightsSearch(search, context);
  const request = insightsRequest(search, context);
  const settings = useQuery({
    ...insightsSettingsQuery(slug),
    enabled: request !== null,
  });
  const result = useQuery({
    ...insightsBurnQuery(
      slug,
      request ??
        insightsPresetRequest("30d", resolved.grain, resolved.tz, context.now),
      settings.data?.version ?? "",
    ),
    enabled: request !== null && settings.data !== undefined,
  });
  const coldFailure =
    settings.data === undefined && settings.isError
      ? settings
      : result.data === undefined && result.isError
        ? result
        : null;

  return (
    <div className="min-w-0 space-y-5">
      <h1 className="text-xl font-semibold">Insights</h1>
      <InsightsControls
        key={`${resolved.range}/${resolved.from}/${resolved.to}/${resolved.grain}/${resolved.tz}`}
        search={resolved}
        context={context}
        onChange={(next) => {
          const { invalid: _invalid, ...validated } = next;
          void navigate({
            to: "/projects/$slug/insights",
            params: { slug },
            search: validated,
            replace: true,
          });
        }}
      />
      {resolved.invalid && (
        <p role="status" className="text-sm text-destructive">
          Invalid URL filters were reset to safe defaults.
        </p>
      )}
      {request === null ? (
        <p role="alert" className="text-sm text-destructive">
          Choose a valid custom range of at most 366 days. The end date is
          included.
        </p>
      ) : coldFailure !== null ? (
        <LoadFailure
          message={`Could not load insights: ${coldFailure.error?.message}`}
          detail={coldFailure.error?.message}
          onRetry={() => void coldFailure.refetch()}
          retrying={coldFailure.isFetching}
        />
      ) : result.data === undefined ? (
        <PageSkeleton kind="insights" />
      ) : (
        <>
          {settings.isError && (
            <RefreshFailure
              what="insights settings"
              detail={settings.error.message}
              onRetry={() => void settings.refetch()}
              retrying={settings.isFetching}
            />
          )}
          {result.isError && (
            <RefreshFailure
              what="insights"
              detail={result.error.message}
              onRetry={() => void result.refetch()}
              retrying={result.isFetching}
            />
          )}
          {result.isFetching && (
            <p role="status" className="text-sm text-muted-foreground">
              Updating insights…
            </p>
          )}
          <InsightsResults data={result.data} />
        </>
      )}
    </div>
  );
}

export function InsightsControls({
  search,
  context,
  onChange,
}: {
  search: ResolvedInsightsSearch;
  context: InsightsSearchContext;
  onChange: (search: InsightsSearch) => void;
}) {
  const defaultRange = insightsPresetRequest(
    "30d",
    search.grain,
    search.tz,
    context.now,
  );
  const defaultEnd = new Date(`${defaultRange.to}T00:00:00Z`);
  defaultEnd.setUTCDate(defaultEnd.getUTCDate() - 1);
  const [from, setFrom] = useState(search.from ?? defaultRange.from);
  const [to, setTo] = useState(
    search.to ?? defaultEnd.toISOString().slice(0, 10),
  );
  const [error, setError] = useState<string | null>(null);
  const timezones = [...new Set([search.tz, context.timezone, "UTC"])];
  const controlClass = "h-9 rounded-md border bg-background px-2 text-sm";

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const next = { ...search, range: "custom" as const, from, to };
        if (insightsRequest(next, context) === null) {
          setError("Choose valid dates in order, spanning at most 366 days.");
          return;
        }
        setError(null);
        onChange(next);
      }}
    >
      <label className="grid gap-1 text-sm">
        Range
        <select
          className={controlClass}
          value={search.range}
          onChange={(event) => {
            const range = event.target.value;
            if (range === "custom") {
              onChange({ ...search, range, from, to });
            } else {
              const preset = INSIGHTS_PRESETS.find((value) => value === range);
              if (preset)
                onChange({ range: preset, grain: search.grain, tz: search.tz });
            }
          }}
        >
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {search.range === "custom" && (
        <>
          <label className="grid gap-1 text-sm">
            From
            <input
              className={controlClass}
              type="date"
              required
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            To (inclusive)
            <input
              className={controlClass}
              type="date"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" size="sm">
            Apply range
          </Button>
        </>
      )}
      <label className="grid gap-1 text-sm">
        Grain
        <select
          className={controlClass}
          value={search.grain}
          onChange={(event) =>
            onChange({ ...search, grain: Grain.parse(event.target.value) })
          }
        >
          <option value="auto">Auto</option>
          <option value="1h">1 hour</option>
          <option value="6h">6 hours</option>
          <option value="12h">12 hours</option>
          <option value="1d">1 day</option>
          <option value="1w">1 week</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Timezone
        <select
          className={controlClass}
          value={search.tz}
          onChange={(event) => onChange({ ...search, tz: event.target.value })}
        >
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone}>
              {timezone}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function InsightsResults({ data }: { data: BurnResponse }) {
  const [selection, setSelection] = useState({
    data,
    index: data.buckets.length - 1,
  });
  if (selection.data !== data) {
    setSelection({ data, index: data.buckets.length - 1 });
  }
  const selectedIndex =
    selection.data === data ? selection.index : data.buckets.length - 1;
  const props = {
    data,
    selectedIndex,
    onSelect: (index: number) => setSelection({ data, index }),
  };
  return (
    <div className="space-y-5">
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>
          Current cohort: {data.cohort.count} cards currently in this project.
          Historical membership outside this cohort is not included.
        </p>
        <p>
          As of <time dateTime={data.as_of}>{data.as_of}</time> ·{" "}
          {data.resolved_grain} buckets · {data.timezone}
        </p>
        {data.history_coverage.has_unknown && (
          <p role="status">
            Some history is unknown. Gaps are not zero; exact reads include
            known values and unknown counts.{" "}
            {data.history_coverage.reasons
              .map((reason) => reason.replaceAll("_", " "))
              .join(", ")}
          </p>
        )}
      </div>
      {data.buckets.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-muted-foreground">
          No buckets in this range.
        </p>
      ) : (
        <>
          {data.cohort.count === 0 && (
            <p role="status">No cards in the current cohort.</p>
          )}
          <div className="grid min-w-0 gap-5 xl:grid-cols-2">
            <BurnChart {...props} />
            <StatusFlowChart {...props} />
          </div>
          <BucketInspector {...props} />
          <BucketTable {...props} />
        </>
      )}
    </div>
  );
}
