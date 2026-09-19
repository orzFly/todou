import type {
  BurnQuery,
  BurnResponse,
  CoverageReason,
  Settings,
} from "@todou/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  insightsSettings,
  issueEvents,
  issues,
  projectMeta,
  statuses,
} from "../db/project-schema.ts";
import { DomainError } from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import {
  calendarProvider,
  dateValue,
  localDateBoundary,
  rowsFrom,
  validatedTimezone,
} from "./calendar.ts";
import { aggregateInsights } from "./insights/aggregate.ts";
import { buildBuckets } from "./insights/buckets.ts";
import { type ReplayEvent, replayIssue } from "./insights/replay.ts";
import { insightsSettingsResponse } from "./insights-settings.ts";
import { live } from "./trash.ts";

const REPLAY_EVENT_TYPES = [
  "opened",
  "closed",
  "reopened",
  "status_changed",
  "deleted",
  "restored",
  "moved_in",
] as const;

function validation(message: string, details?: unknown): DomainError {
  return new DomainError(400, "validation_failed", message, details);
}

function isLocalDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function resolveRange(
  db: Db,
  query: BurnQuery,
): Promise<{ from: Date; to: Date; timezone: string }> {
  const timezone = await validatedTimezone(db, query.tz);
  const dates = isLocalDate(query.from);
  const from = dates
    ? await localDateBoundary(db, query.from, timezone)
    : new Date(query.from);
  const to = dates
    ? await localDateBoundary(db, query.to, timezone)
    : new Date(query.to);
  if (to <= from) throw validation("to must resolve later than from");
  return { from, to, timezone };
}

type Snapshot = {
  asOf: Date;
  projectCreatedAt: Date;
  settings: Settings;
  statusRows: Array<typeof statuses.$inferSelect>;
  issueRows: Array<{ id: number; createdAt: Date; statusId: number }>;
  eventRows: Array<{
    id: number;
    issueId: number;
    type: typeof issueEvents.$inferSelect.type;
    payload: unknown;
    createdAt: Date;
  }>;
};

async function readSnapshot(db: Db, projectId: number): Promise<Snapshot> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"),
    );
    const nowRows = rowsFrom(await tx.execute(sql`select now() as as_of`));
    const statusRows = await tx
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, projectId))
      .orderBy(asc(statuses.position), asc(statuses.id));
    const savedRows = await tx
      .select()
      .from(insightsSettings)
      .where(eq(insightsSettings.projectId, projectId));
    const metaRows = await tx
      .select({ createdAt: projectMeta.createdAt })
      .from(projectMeta)
      .where(eq(projectMeta.projectId, projectId));
    const issueRows = await tx
      .select({
        id: issues.id,
        createdAt: issues.createdAt,
        statusId: issues.statusId,
      })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), live));
    const eventRows = await tx
      .select({
        id: issueEvents.id,
        issueId: issueEvents.issueId,
        type: issueEvents.type,
        payload: issueEvents.payload,
        createdAt: issueEvents.createdAt,
      })
      .from(issueEvents)
      .innerJoin(
        issues,
        and(
          eq(issues.id, issueEvents.issueId),
          eq(issues.projectId, projectId),
          live,
        ),
      )
      .where(
        and(
          eq(issueEvents.projectId, projectId),
          inArray(issueEvents.type, [...REPLAY_EVENT_TYPES]),
        ),
      )
      .orderBy(
        asc(issueEvents.issueId),
        asc(issueEvents.createdAt),
        asc(issueEvents.id),
      );
    const meta = metaRows[0];
    if (!meta) throw new Error("project metadata is missing");
    return {
      asOf: dateValue(nowRows[0], "as_of"),
      projectCreatedAt: meta.createdAt,
      settings: insightsSettingsResponse(statusRows, savedRows[0]),
      statusRows,
      issueRows,
      eventRows,
    };
  });
}

export async function getInsightsBurn(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  query: BurnQuery,
): Promise<BurnResponse> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "activity.read",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const range = await resolveRange(db, query);
  const snapshot = await readSnapshot(db, project.id);
  const bucketPlan = await buildBuckets({
    ...range,
    asOf: snapshot.asOf,
    grain: query.grain,
    calendar: calendarProvider(db),
  });
  const eventsByIssue = new Map<number, ReplayEvent[]>();
  for (const event of snapshot.eventRows) {
    const list = eventsByIssue.get(event.issueId) ?? [];
    list.push({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      payload: event.payload,
    });
    eventsByIssue.set(event.issueId, list);
  }
  const replayed = snapshot.issueRows.map((issue) =>
    replayIssue(
      { id: issue.id, createdAt: issue.createdAt, statusId: issue.statusId },
      eventsByIssue.get(issue.id) ?? [],
    ),
  );
  const aggregation = aggregateInsights({
    statuses: snapshot.settings.roles,
    issues: replayed,
    buckets: bucketPlan.buckets,
    from: range.from,
    projectCreatedAt: snapshot.projectCreatedAt,
  });
  const reasons = [
    ...new Set<CoverageReason>([
      ...aggregation.reasons,
      ...aggregation.buckets.flatMap((bucket) => bucket.reasons),
    ]),
  ];
  const effectiveTo = range.to < snapshot.asOf ? range.to : snapshot.asOf;
  return {
    as_of: snapshot.asOf.toISOString(),
    from: range.from.toISOString(),
    to: effectiveTo.toISOString(),
    requested_grain: query.grain,
    resolved_grain: bucketPlan.resolvedGrain,
    timezone: range.timezone,
    settings_version: snapshot.settings.version,
    cohort: { mode: "current", count: snapshot.issueRows.length },
    history_coverage: {
      project_created_at: snapshot.projectCreatedAt.toISOString(),
      mode: "current_cohort",
      has_unknown: reasons.length > 0,
      reasons,
    },
    statuses: snapshot.settings.roles,
    opening: aggregation.opening,
    buckets: aggregation.buckets,
  };
}
