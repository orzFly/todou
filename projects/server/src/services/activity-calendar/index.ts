import type {
  ActivityCalendarQuery,
  ActivityCalendarResponse,
  ActivityCard,
} from "@todou/shared";
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { UserRow } from "../../auth/pat.ts";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import {
  issueMoves,
  projects,
  refPrefixes,
  users,
} from "../../db/system-schema.ts";
import { ConflictError } from "../../errors.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  requireCapability,
  routeInfoOf,
} from "../access.ts";
import { localDateBoundarySql, rowsFrom } from "../calendar.ts";
import { microIso } from "../timeline.ts";
import { resolveVisibleUser } from "../users.ts";
import { type ActivityBucketPlan, buildActivityBuckets } from "./buckets.ts";
import {
  activityCalendarScopeHash,
  paginateActivityCalendar,
} from "./cursor.ts";
import {
  activityActorPredicate,
  activityCommentEvidence,
  activityEventPredicate,
  activityMalformedEventPredicate,
  activityRevisionEvidence,
} from "./evidence.ts";
import {
  type ActivityEvidenceSource,
  activityLegacyRevisionBoundaryPredicate,
  activityLiveCandidatePredicate,
  activityMembershipPredicate,
} from "./membership.ts";

type Scope = { type: "project" | "user"; id: number };
type Candidate = ActivityCard & { project_id: number };
type MoveHead = {
  issue_id: number;
  number: number;
  event_id: number;
  token: string | null;
  legacy: boolean;
};
type LegacyMove = {
  token: string;
  project_id: number;
  number: number | null;
  state: string;
  finished_at: string | null;
};

function changed(): ConflictError {
  return new ConflictError("activity changed; restart the calendar", {
    reason: "activity_changed",
    restart: true,
  });
}

const latestMoves = (projectId: number) => sql`
  select distinct on (issue_id) issue_id, id, payload
  from issue_events where project_id = ${projectId} and type = 'moved_in'
  order by issue_id, id desc`;

/** Only move identities, read once before system prefetch and again in snapshot. */
async function moveHeads(db: Db, projectId: number): Promise<MoveHead[]> {
  return rowsFrom(
    await db.execute(sql`
    with latest_moves as (${latestMoves(projectId)})
    select i.id as issue_id, i.number, m.id as event_id,
      m.payload ->> 'move_token' as token,
      not (m.payload ? 'activity_imported_max_ids') as legacy
    from issues i join latest_moves m on m.issue_id = i.id
    where i.project_id = ${projectId}
      and ${activityLiveCandidatePredicate({ deletedAt: sql`i.deleted_at`, movedAt: sql`i.moved_at` })}
    order by i.id
  `),
  ).map((row) => ({
    issue_id: Number(row.issue_id),
    number: Number(row.number),
    event_id: Number(row.event_id),
    token: typeof row.token === "string" ? row.token : null,
    legacy: row.legacy === true,
  }));
}

async function legacyMoves(
  ctx: AppContext,
  projectId: number,
  heads: MoveHead[],
): Promise<LegacyMove[]> {
  const tokens = heads
    .filter((head) => head.legacy && head.token !== null)
    .map((head) => head.token as string);
  if (tokens.length === 0) return [];
  // Never acquire the system handle while a project transaction is open:
  // shared PGlite has one connection, so that would wait on its own snapshot.
  const rows = await ctx.router
    .system()
    .select({
      token: issueMoves.moveToken,
      project_id: issueMoves.toProjectId,
      number: issueMoves.toNumber,
      state: issueMoves.state,
      finished_at: microIso(issueMoves.finishedAt),
    })
    .from(issueMoves)
    .where(
      and(
        eq(issueMoves.toProjectId, projectId),
        inArray(issueMoves.moveToken, tokens),
        eq(issueMoves.state, "done"),
      ),
    );
  return rows;
}

/** One definition feeds both SQL projections inside the same read snapshot. */
function cardDayRelation(input: {
  projectId: number;
  actorId?: number;
  bornAt: string;
  cutoff: string;
  plan: ActivityBucketPlan;
  moves: LegacyMove[];
}): SQL {
  const { projectId, actorId, bornAt, cutoff, plan, moves } = input;
  const membership = (
    source: ActivityEvidenceSource,
    id: SQL,
    createdAt: SQL,
  ) =>
    activityMembershipPredicate({
      source,
      id,
      createdAt,
      issueCreatedAt: sql`i.created_at`,
      latestMovedInId: sql`i.move_id`,
      latestMovedInPayload: sql`i.move_payload`,
      legacyRevisionFinishedAt: sql`i.legacy_finished_at`,
    });
  const comment = activityCommentEvidence({
    id: sql`c.id`,
    issueId: sql`c.issue_id`,
    authorId: sql`c.author_id`,
    createdAt: sql`c.created_at`,
  });
  const revisionColumns = {
    id: sql`r.id`,
    subjectType: sql`r.subject_type`,
    subjectId: sql`r.subject_id`,
    actorId: sql`r.actor_id`,
    createdAt: sql`r.created_at`,
  };
  const bodyRevision = activityRevisionEvidence(revisionColumns, {
    issueId: sql`i.id`,
  });
  const commentRevision = activityRevisionEvidence(revisionColumns, {
    issueId: sql`i.id`,
    commentId: sql`c.id`,
  });
  const verifiedLegacy = activityLegacyRevisionBoundaryPredicate(
    {
      moveToken: sql`lm.token`,
      toProjectId: sql`lm.project_id`,
      toNumber: sql`lm.number`,
      state: sql`lm.state`,
      finishedAt: sql`lm.finished_at`,
    },
    {
      moveToken: sql`m.payload ->> 'move_token'`,
      projectId: sql`i.project_id`,
      number: sql`i.number`,
    },
  );
  return sql`
    with latest_moves as (${latestMoves(projectId)}),
    legacy_moves as (
      select * from jsonb_to_recordset(${JSON.stringify(moves)}::jsonb)
      as lm(token text, project_id bigint, number bigint, state text, finished_at timestamptz)
    ), live_candidates as (
      select i.id, i.created_at, m.id as move_id, m.payload as move_payload,
        lm.finished_at as legacy_finished_at
      from issues i left join latest_moves m on m.issue_id = i.id
      left join legacy_moves lm on ${verifiedLegacy}
      where i.project_id = ${projectId}
        and ${activityLiveCandidatePredicate({ deletedAt: sql`i.deleted_at`, movedAt: sql`i.moved_at` })}
    ), event_candidates as (
      select i.id as issue_id, e.created_at as occurred_at, e.type,
        ${activityEventPredicate({ type: sql`e.type`, payload: sql`e.payload` })} as included,
        ${activityMalformedEventPredicate({ type: sql`e.type`, payload: sql`e.payload` })} as malformed
      from live_candidates i join issue_events e on e.issue_id = i.id and e.project_id = ${projectId}
      where ${activityActorPredicate(sql`e.actor_id`, actorId)}
        and ${membership("events", sql`e.id`, sql`e.created_at`)}
        and e.created_at >= ${localDateBoundarySql(sql`${plan.fromDate}`, plan.timezone, { earliest: true })}
        and e.created_at < ${localDateBoundarySql(sql`${plan.toDate}`, plan.timezone, { earliest: true })}
        and e.created_at >= ${bornAt}::timestamptz and e.created_at < ${cutoff}::timestamptz
    ), activity_evidence as (
      select issue_id, occurred_at from event_candidates where included
      union all
      select ${comment.issueId}, ${comment.occurredAt}
      from live_candidates i join comments c on c.issue_id = i.id and c.project_id = ${projectId}
      where ${activityActorPredicate(comment.actorId, actorId)}
        and ${membership("comments", sql`c.id`, sql`c.created_at`)}
      union all
      select ${bodyRevision.issueId}, ${bodyRevision.occurredAt}
      from revisions r
      join live_candidates i on r.subject_id = i.id
      where r.project_id = ${projectId} and r.subject_type = 'issue_body'
        and ${bodyRevision.predicate}
        and ${activityActorPredicate(bodyRevision.actorId, actorId)}
        and ${membership("revisions", sql`r.id`, sql`r.created_at`)}
      union all
      select ${commentRevision.issueId}, ${commentRevision.occurredAt}
      from revisions r
      join comments c on c.id = r.subject_id and c.project_id = ${projectId}
      join live_candidates i on c.issue_id = i.id
      where r.project_id = ${projectId} and r.subject_type = 'comment'
        and ${commentRevision.predicate}
        and ${activityActorPredicate(commentRevision.actorId, actorId)}
        and ${membership("revisions", sql`r.id`, sql`r.created_at`)}
    ), activity_card_days as (
      select to_char(timezone(${plan.timezone}, occurred_at), 'YYYY-MM-DD') as date,
        issue_id, max(occurred_at) as last_active_at
      from activity_evidence
      where occurred_at >= ${localDateBoundarySql(sql`${plan.fromDate}`, plan.timezone, { earliest: true })}
        and occurred_at < ${localDateBoundarySql(sql`${plan.toDate}`, plan.timezone, { earliest: true })}
        and occurred_at >= ${bornAt}::timestamptz and occurred_at < ${cutoff}::timestamptz
      group by 1, issue_id
    )`;
}

async function projectSnapshot(
  ctx: AppContext,
  project: ProjectRow,
  prefix: string | null,
  input: {
    actorId?: number;
    bornAt: string;
    cutoff: string;
    plan: ActivityBucketPlan;
    day?: string;
  },
): Promise<{
  counts: Array<{ date: string; count: number }>;
  cards: Candidate[];
}> {
  // Resolve and consume sequentially: opening all project handles up front can
  // let the router's LRU evict one before its query starts.
  const db = await ctx.router.forProject(routeInfoOf(project));
  for (let attempt = 0; attempt < 2; attempt++) {
    const heads = await moveHeads(db, project.id);
    const moves = await legacyMoves(ctx, project.id, heads);
    const result = await db.transaction(
      async (tx) => {
        const current = await moveHeads(tx, project.id);
        if (JSON.stringify(current) !== JSON.stringify(heads)) return null;
        const relation = cardDayRelation({
          ...input,
          projectId: project.id,
          moves,
        });
        // The event candidate scan supplies both activity and grouped malformed
        // diagnostics. No second yearly scan, and no payload reaches JS/logs.
        const aggregateRows = rowsFrom(
          await tx.execute(sql`${relation}, annual_counts as (
            select date, count(*) as count from activity_card_days group by date
          )
          select 'day' as kind, date as key, count from annual_counts
          union all
          select 'malformed' as kind, type as key, count(*) as count
          from event_candidates where malformed group by type
          order by kind, key
      `),
        );
        const counts = aggregateRows
          .filter((row) => row.kind === "day")
          .map((row) => ({ date: String(row.key), count: Number(row.count) }));
        const diagnostics = aggregateRows
          .filter((row) => row.kind === "malformed")
          .map((row) => ({ type: String(row.key), count: Number(row.count) }));
        if (
          counts.some(
            (row) => !Number.isSafeInteger(row.count) || row.count < 0,
          )
        )
          throw new Error("activity count exceeds the response range");
        const selected =
          input.day === undefined
            ? []
            : rowsFrom(
                await tx.execute(sql`${relation}
        select d.issue_id, i.number, i.title,
          to_char(d.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_active_at,
          json_build_object('id', s.id, 'name', s.name, 'category', s.category,
            'color', s.color, 'position', s.position, 'is_default', s.is_default) as status
        from activity_card_days d join issues i on i.id = d.issue_id and i.project_id = ${project.id}
        join statuses s on s.id = i.status_id and s.project_id = ${project.id}
        where d.date = ${input.day}
      `),
              );
        const cards = selected.map(
          (row): Candidate => ({
            project_id: project.id,
            project: {
              id: project.id,
              slug: project.slug,
              name: project.name,
              issue_prefix: prefix,
            },
            issue_id: Number(row.issue_id),
            number: Number(row.number),
            title: String(row.title),
            status: row.status as ActivityCard["status"],
            last_active_at: String(row.last_active_at),
            url: `/projects/${encodeURIComponent(project.slug)}/issues/${Number(row.number)}`,
          }),
        );
        return { counts, cards, diagnostics };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    if (result !== null) {
      if (result.diagnostics.length > 0) {
        console.warn("activity calendar: malformed event payloads", {
          project_id: project.id,
          events: result.diagnostics,
        });
      }
      const missing = heads.filter(
        (head) =>
          head.legacy &&
          !moves.some(
            (move) =>
              move.token === head.token &&
              move.number === head.number &&
              move.finished_at !== null,
          ),
      );
      if (missing.length > 0)
        console.warn(
          "activity calendar: unavailable legacy revision boundaries",
          {
            project_id: project.id,
            count: missing.length,
          },
        );
      return result;
    }
  }
  throw changed();
}

async function authorizedScope(
  ctx: AppContext,
  viewer: UserRow,
  scope: Scope,
): Promise<ProjectRow[]> {
  if (scope.type === "project") {
    return [
      (await requireCapability(ctx, viewer, String(scope.id), "activity.read"))
        .project,
    ];
  }
  const projects = await accessibleProjectRows(ctx, viewer);
  const authorized: ProjectRow[] = [];
  for (const project of projects) {
    authorized.push(
      (
        await requireCapability(
          ctx,
          viewer,
          String(project.id),
          "activity.read",
        )
      ).project,
    );
  }
  return authorized.sort((a, b) => a.id - b.id);
}

async function calendar(
  ctx: AppContext,
  viewer: UserRow,
  scope: Scope,
  query: ActivityCalendarQuery,
  cutoff: string,
): Promise<ActivityCalendarResponse> {
  const readStartedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (scope.type === "user")
      await resolveVisibleUser(ctx, viewer, String(scope.id));
    const readable = await authorizedScope(ctx, viewer, scope);
    const ids = readable.map((project) => project.id);
    const system = ctx.router.system();
    const bornRows =
      scope.type === "project"
        ? await system
            .select({ at: microIso(projects.createdAt) })
            .from(projects)
            .where(eq(projects.id, scope.id))
        : await system
            .select({ at: microIso(users.createdAt) })
            .from(users)
            .where(eq(users.id, scope.id));
    const bornAt = bornRows[0]?.at;
    if (typeof bornAt !== "string")
      throw new Error("calendar subject birth is unavailable");
    const plan = await buildActivityBuckets(system, {
      year: query.year,
      timezone: query.tz,
      cutoff,
      bornAt,
      day: query.day,
    });
    const prefixes = new Map<number, string | null>();
    if (ids.length > 0) {
      const rows = await system
        .select({
          projectId: refPrefixes.projectId,
          prefix: refPrefixes.prefix,
        })
        .from(refPrefixes)
        .where(inArray(refPrefixes.projectId, ids))
        .orderBy(asc(refPrefixes.effectiveFrom), asc(refPrefixes.id));
      for (const row of rows) prefixes.set(row.projectId, row.prefix);
    }
    const counts = new Map<string, number>();
    const cards: Candidate[] = [];
    for (const project of readable) {
      const result = await projectSnapshot(
        ctx,
        project,
        prefixes.get(project.id) ?? null,
        {
          actorId: scope.type === "user" ? scope.id : undefined,
          bornAt,
          cutoff,
          plan,
          day: query.day,
        },
      );
      for (const row of result.counts)
        counts.set(row.date, (counts.get(row.date) ?? 0) + row.count);
      cards.push(...result.cards);
    }
    // Canonical ids survive aliases/renames. Subject visibility is independent
    // of viewer scope, so it must be checked even when that scope is unchanged.
    if (scope.type === "user")
      await resolveVisibleUser(ctx, viewer, String(scope.id));
    const current = await authorizedScope(ctx, viewer, scope);
    if (
      activityCalendarScopeHash(current.map((project) => project.id)) !==
      activityCalendarScopeHash(ids)
    ) {
      if (attempt === 0) continue;
      throw changed();
    }
    const days = plan.days.map((day) => {
      if (day.state !== "recorded") return day;
      const count = counts.get(day.date) ?? 0;
      if (!Number.isSafeInteger(count))
        throw new Error("activity count exceeds the response range");
      return { ...day, count };
    });
    let selection: ActivityCalendarResponse["selection"] = null;
    if (query.day !== undefined) {
      const page = paginateActivityCalendar(
        cards,
        ids,
        {
          viewer_id: viewer.id,
          scope,
          year: query.year,
          day: query.day,
          tz: plan.timezone,
          limit: query.limit,
        },
        query.after,
      );
      if (page.total !== (counts.get(query.day) ?? 0))
        throw new Error("activity selection differs from its snapshot count");
      selection = {
        date: query.day,
        ...page,
        items: page.items.map(({ project_id: _projectId, ...card }) => card),
      };
    }
    return {
      year: query.year,
      timezone: plan.timezone,
      cutoff,
      read_started_at: readStartedAt,
      read_finished_at: new Date().toISOString(),
      days,
      selection,
    };
  }
  throw changed();
}

export async function getProjectActivityCalendar(
  ctx: AppContext,
  viewer: UserRow,
  ref: string,
  query: ActivityCalendarQuery,
): Promise<ActivityCalendarResponse> {
  const cutoff = new Date().toISOString();
  const { project } = await requireCapability(
    ctx,
    viewer,
    ref,
    "activity.read",
  );
  return calendar(
    ctx,
    viewer,
    { type: "project", id: project.id },
    query,
    cutoff,
  );
}

export async function getUserActivityCalendar(
  ctx: AppContext,
  viewer: UserRow,
  ref: string,
  query: ActivityCalendarQuery,
): Promise<ActivityCalendarResponse> {
  const cutoff = new Date().toISOString();
  const subject = await resolveVisibleUser(ctx, viewer, ref);
  return calendar(ctx, viewer, { type: "user", id: subject.id }, query, cutoff);
}
