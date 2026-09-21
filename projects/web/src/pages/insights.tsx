import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type BurnResponse,
  Grain,
  type Grain as GrainValue,
} from "@todou/shared";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { insightsBurnQuery, insightsSettingsQuery } from "@/api/insights.ts";
import { meQuery, projectQuery } from "@/api/queries.ts";
import { ActivityCalendarSection } from "@/components/activity-calendar/activity-calendar-section.tsx";
import { BurnChart } from "@/components/insights/burn-chart.tsx";
import { StatusFlowChart } from "@/components/insights/status-flow-chart.tsx";
import { InsightsResultsSkeleton } from "@/components/page-skeleton.tsx";
import {
  LoadFailure,
  RefreshFailure,
} from "@/components/shared/load-failure.tsx";
import { Button } from "@/components/ui/button";
import {
  activityDateSearchParams,
  activityToday,
  browserActivityTimezone,
  centredActivityWindow,
  resolveActivityDateSearch,
  rollingActivityWindow,
} from "@/lib/activity-calendar-search.ts";
import type {
  InsightsSearch,
  InsightsSearchContext,
  ResolvedInsightsSearch,
} from "@/lib/insights-search.ts";
import {
  insightsPresetRequest,
  insightsRequest,
  parseInsightsSearch,
  resolveInsightsSearch,
  shiftCalendarDate,
} from "@/lib/insights-search.ts";
import type {
  InsightsHover,
  InsightsLink,
  TimeSpan,
} from "@/lib/insights-selection.ts";

export function InsightsPage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  // Router search includes raw keys; only the parser may derive invalidity.
  const search = parseInsightsSearch(
    useSearch({ from: "/authed/projects/$slug/insights" }),
  );
  const navigate = useNavigate();
  const viewer = useQuery(meQuery);
  const project = useQuery(projectQuery(slug));
  const [context] = useState<InsightsSearchContext>(() => ({
    now: new Date(),
    timezone: browserActivityTimezone(),
  }));
  // Where the reader is pointing and what they picked out of the window. Both
  // stay out of the URL: they answer "right now", and a restored hover would
  // claim a pointer that is no longer on the page.
  const [hover, setHover] = useState<InsightsHover | null>(null);
  const [selection, setSelection] = useState<TimeSpan | null>(null);
  // One object per render handed to every surface, so a pointer on any of them
  // reaches all of them in the same commit. Neither value feeds the queries
  // below: picking a range must never move the window it was picked out of.
  const link: InsightsLink = {
    hover,
    selection,
    onHover: setHover,
    onSelect: setSelection,
  };
  const resolved = resolveInsightsSearch(search, context);
  const activity = resolveActivityDateSearch(search, context);
  const today = activityToday(context.now, context.timezone);
  // A custom range makes the calendar its own picker, so the window frames that
  // range; every preset leaves it on the rolling one.
  const activityWindow =
    resolved.range === "custom" &&
    resolved.from !== undefined &&
    resolved.to !== undefined
      ? centredActivityWindow(
          resolved.from,
          shiftCalendarDate(resolved.to, 1),
          today,
        )
      : rollingActivityWindow(today);
  const activityInvalidNotified = useRef(false);
  useEffect(() => {
    if (activity.invalid && !activityInvalidNotified.current) {
      activityInvalidNotified.current = true;
      toast("Invalid activity date was reset.");
      void navigate({
        to: "/projects/$slug/insights",
        params: { slug },
        search: activityDateSearchParams({
          ...search,
          activity_day: activity.day,
        }),
        replace: true,
      });
    }
  }, [activity.invalid, activity.day, navigate, search, slug]);
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
          void navigate({
            to: "/projects/$slug/insights",
            params: { slug },
            search: {
              activity_day: search.activity_day,
              range: next.range,
              from: next.from,
              to: next.to,
              grain: next.grain,
            },
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
          Choose a valid custom range of at most 366 days.
        </p>
      ) : coldFailure !== null ? (
        <LoadFailure
          message={`Could not load insights: ${coldFailure.error?.message}`}
          detail={coldFailure.error?.message}
          onRetry={() => void coldFailure.refetch()}
          retrying={coldFailure.isFetching}
        />
      ) : result.data === undefined ? (
        <InsightsResultsSkeleton />
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
          <InsightsResults data={result.data} link={link} />
        </>
      )}
      {viewer.data && project.data && (
        <ActivityCalendarSection
          viewerId={viewer.data.id}
          scope={{
            kind: "project",
            projectId: project.data.id,
            slug: project.data.slug,
          }}
          {...activityWindow}
          day={activity.day}
          link={link}
          timezone={context.timezone}
          today={today}
          onInvalidDay={(day) => {
            if (!activityInvalidNotified.current) {
              activityInvalidNotified.current = true;
              toast("Invalid activity date was reset.");
            }
            void navigate({
              to: "/projects/$slug/insights",
              params: { slug },
              search: activityDateSearchParams(
                parseInsightsSearch({ ...search, activity_day: day }),
              ),
              replace: true,
            });
          }}
          onDayChange={(day, options) =>
            void navigate({
              to: "/projects/$slug/insights",
              params: { slug },
              search: activityDateSearchParams(
                parseInsightsSearch({ ...search, activity_day: day }),
              ),
              replace: options?.replace ?? false,
            })
          }
          // The charts' span lives in component state and the calendar clears
          // it itself; the day is in the URL, so dropping it is a navigation.
          onClearDay={() =>
            void navigate({
              to: "/projects/$slug/insights",
              params: { slug },
              search: activityDateSearchParams(
                parseInsightsSearch({ ...search, activity_day: undefined }),
              ),
            })
          }
        />
      )}
    </div>
  );
}

const RANGE_OPTIONS = [
  ["24h", "24h"],
  ["7d", "7d"],
  ["30d", "30d"],
  ["90d", "90d"],
  ["custom", "Custom"],
] as const;

const GRAIN_LABELS: Record<GrainValue, string> = {
  auto: "Auto",
  "1h": "1h",
  "6h": "6h",
  "12h": "12h",
  "1d": "1d",
  "1w": "1w",
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
}: {
  search: ResolvedInsightsSearch;
  context: InsightsSearchContext;
  onChange: (search: InsightsSearch) => void;
}) {
  const { tz: _tz, invalid: _invalid, ...filters } = search;
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
  const controlClass = "h-9 rounded-md border bg-background px-2 text-sm";

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const next = { ...filters, range: "custom" as const, from, to };
        if (insightsRequest(next, context) === null) {
          setError("Choose valid dates in order, spanning at most 366 days.");
          return;
        }
        setError(null);
        onChange(next);
      }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-between">
        <fieldset aria-label="Time range" className="min-w-0 space-y-2">
          <legend className="text-sm text-muted-foreground">Time range</legend>
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
                    ? onChange({ ...filters, range, from, to })
                    : onChange({ range, grain: search.grain })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset aria-label="Granularity" className="min-w-0 space-y-2">
          <legend className="text-sm text-muted-foreground">Granularity</legend>
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
                  disabled={exceeds}
                  className={`${segmentButtonClass} ${
                    search.grain === grain
                      ? "border-border bg-background text-foreground shadow-sm"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => onChange({ ...filters, grain })}
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
            Start date
            <input
              className={`${controlClass} max-w-32`}
              type="date"
              required
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            End date
            <input
              className={`${controlClass} max-w-32`}
              type="date"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" size="sm">
            Apply dates
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function InsightsResults({
  data,
  link,
}: {
  data: BurnResponse;
  /** Absent where the charts stand alone; they simply draw no linked marks. */
  link?: InsightsLink;
}) {
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
    link,
  };
  return (
    <div className="space-y-5">
      {data.buckets.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-dashed p-6 text-muted-foreground"
        >
          No data in this range.
        </p>
      ) : (
        <>
          {data.cohort.count === 0 && (
            <p role="status">No cards in this project.</p>
          )}
          <div className="grid min-w-0 gap-5 xl:grid-cols-2">
            <BurnChart {...props} />
            <StatusFlowChart {...props} />
          </div>
        </>
      )}
    </div>
  );
}
