import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type BurnResponse,
  Grain,
  type Grain as GrainValue,
} from "@todou/shared";
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
        resolvedGrain={result.data?.resolved_grain}
        bucketCount={result.data?.buckets.length}
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

const RANGE_OPTIONS = [
  ["24h", "24h"],
  ["7d", "7天"],
  ["30d", "30天"],
  ["90d", "90天"],
  ["custom", "自定义"],
] as const;

const GRAIN_LABELS: Record<GrainValue, string> = {
  auto: "自动",
  "1h": "1h",
  "6h": "6h",
  "12h": "12h",
  "1d": "1天",
  "1w": "1周",
};

const HOUR_MS = 60 * 60 * 1000;

// A conservative lower bound, never an approximation of a local midnight:
// the server alone decides actual IANA calendar boundaries and the 400 limit.
// Subtracting three days for date inputs leaves even skipped dates and DST
// changes to the server while disabling clearly impossible hourly choices.
function minimumHourlyBuckets(
  search: ResolvedInsightsSearch,
  context: InsightsSearchContext,
  grain: "1h" | "6h" | "12h",
): number | null {
  const request = insightsRequest(search, context);
  if (request === null) return null;
  const dates = !request.from.includes("T");
  const from = Date.parse(dates ? `${request.from}T00:00:00Z` : request.from);
  const to = Date.parse(dates ? `${request.to}T00:00:00Z` : request.to);
  const hours = (to - from) / HOUR_MS - (dates ? 72 : 0);
  const step = { "1h": 1, "6h": 6, "12h": 12 }[grain];
  return Math.max(0, Math.floor(hours / step));
}

const segmentClass =
  "inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border bg-muted p-1";
const segmentButtonClass =
  "min-h-9 rounded-md border border-transparent px-3 text-sm font-medium transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40";

export function InsightsControls({
  search,
  context,
  onChange,
  resolvedGrain,
  bucketCount,
}: {
  search: ResolvedInsightsSearch;
  context: InsightsSearchContext;
  onChange: (search: InsightsSearch) => void;
  resolvedGrain?: string;
  bucketCount?: number;
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
  const unavailable = Grain.options.flatMap((grain) => {
    if (grain !== "1h" && grain !== "6h" && grain !== "12h") return [];
    return (minimumHourlyBuckets(search, context, grain) ?? 0) > 400
      ? [GRAIN_LABELS[grain]]
      : [];
  });

  return (
    <form
      className="space-y-3"
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
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-between">
        <fieldset aria-label="时间范围" className="min-w-0 space-y-2">
          <legend className="text-sm text-muted-foreground">时间范围</legend>
          <div className={segmentClass}>
            {RANGE_OPTIONS.map(([range, label]) => (
              <button
                key={range}
                type="button"
                aria-pressed={search.range === range}
                className={`${segmentButtonClass} ${
                  search.range === range
                    ? "border-border bg-background text-foreground shadow-sm"
                    : "text-muted-foreground"
                }`}
                onClick={() =>
                  range === "custom"
                    ? onChange({ ...search, range, from, to })
                    : onChange({ range, grain: search.grain, tz: search.tz })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset aria-label="统计粒度" className="min-w-0 space-y-2">
          <legend className="text-sm text-muted-foreground">统计粒度</legend>
          <div className={segmentClass}>
            {Grain.options.map((grain) => {
              const label = GRAIN_LABELS[grain];
              const exceeds =
                (grain === "1h" || grain === "6h" || grain === "12h") &&
                (minimumHourlyBuckets(search, context, grain) ?? 0) > 400;
              return (
                <button
                  key={grain}
                  type="button"
                  aria-pressed={search.grain === grain}
                  aria-label={
                    exceeds ? `${label}，不可用：超过400桶上限` : undefined
                  }
                  title={
                    exceeds
                      ? "超过400桶上限；请缩短时间范围或选择更粗的粒度"
                      : undefined
                  }
                  disabled={exceeds}
                  className={`${segmentButtonClass} ${
                    search.grain === grain
                      ? "border-border bg-background text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => onChange({ ...search, grain })}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
      {search.range === "custom" && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            开始日期
            <input
              className={`${controlClass} max-w-32`}
              type="date"
              required
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            结束日期
            <input
              className={`${controlClass} max-w-32`}
              type="date"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" size="sm">
            应用日期
          </Button>
          <span className="w-full text-xs text-muted-foreground">
            包含所选结束日期
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="grid gap-1 text-sm">
          时区
          <select
            className={controlClass}
            value={search.tz}
            onChange={(event) =>
              onChange({ ...search, tz: event.target.value })
            }
          >
            {timezones.map((timezone) => (
              <option key={timezone} value={timezone}>
                {timezone}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          {search.grain === "auto" && resolvedGrain
            ? `自动 → ${GRAIN_LABELS[resolvedGrain as Exclude<GrainValue, "auto">] ?? resolvedGrain}`
            : GRAIN_LABELS[search.grain]}
          {bucketCount === undefined ? "" : ` · ${bucketCount} 桶`}
          {" · "}最多 400 桶
        </span>
      </div>
      {unavailable.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {unavailable.join("、")}{" "}
          超过400桶上限；请缩短时间范围或选择更粗的粒度。
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
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
          当前卡片集合：本项目现有 {data.cohort.count}{" "}
          张卡。集合外的历史卡片不计入。
          删除或移出卡片会改写过去的曲线；搬入卡片仅从最近一次进入本项目起计。
          修改状态角色也会重新解释历史。
        </p>
        <p>
          数据截至 <time dateTime={data.as_of}>{data.as_of}</time> ·{" "}
          {data.resolved_grain} 粒度 · {data.timezone}
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
