import type { BulkReadInput, IssueReadInput } from "@todou/shared";
import { and, eq, gt, inArray, max, ne, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issueReads,
  issues,
  readFrontiers,
} from "../db/project-schema.ts";
import { NotFoundError } from "../errors.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import {
  crossRefVisibleCondition,
  type VisibleProjects,
} from "./cross-references.ts";
import { live } from "./trash.ts";

/**
 * The user's unread epoch in each of these projects, created lazily on first
 * use so history before a user starts reading never counts as unread (T-35's
 * CLI bootstrap semantics). Insert-then-reselect keeps concurrent first calls
 * safe — board columns fire several list queries at once on first load.
 *
 * "First use" includes a list that comes back empty (T-151): a project the
 * user has looked at while it had nothing in it is still a project they have
 * started reading, and skipping the frontier there would leave the next batch
 * of foreign cards dated before it — arriving already read.
 *
 * Every caller that reads a frontier threshold through a join has to run this
 * first, or `coalesce(last_seen_at, frontier_at)` is NULL for a project with
 * no row yet and every comparison against it drops the row (T-278).
 */
export async function ensureFrontiers(
  db: Db,
  projectIds: number[],
  userId: number,
): Promise<Map<number, Date>> {
  if (projectIds.length === 0) return new Map();
  const wanted = [...new Set(projectIds)];
  const select = (ids: number[]) =>
    db
      .select({
        projectId: readFrontiers.projectId,
        frontierAt: readFrontiers.frontierAt,
      })
      .from(readFrontiers)
      .where(
        and(
          inArray(readFrontiers.projectId, ids),
          eq(readFrontiers.userId, userId),
        ),
      );

  const found = new Map(
    (await select(wanted)).map((r) => [r.projectId, r.frontierAt]),
  );
  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length === 0) return found;

  const now = new Date();
  await db
    .insert(readFrontiers)
    .values(
      missing.map((projectId) => ({ projectId, userId, frontierAt: now })),
    )
    .onConflictDoNothing();
  for (const r of await select(missing)) found.set(r.projectId, r.frontierAt);
  for (const id of missing) {
    if (!found.has(id)) throw new Error("read frontier missing after insert");
  }
  return found;
}

/** One project's frontier; see `ensureFrontiers`. */
export async function ensureFrontier(
  db: Db,
  projectId: number,
  userId: number,
): Promise<Date> {
  const frontier = (await ensureFrontiers(db, [projectId], userId)).get(
    projectId,
  );
  if (!frontier) throw new Error("read frontier missing after insert");
  return frontier;
}

/**
 * The threshold an unread comparison runs against, as a join rather than a
 * bound value (T-278): `read_frontiers` joined on the row's own project, so
 * one scan can span several projects and so both sides of the comparison are
 * column references. Binding the frontier as a JS `Date` truncated it to
 * milliseconds while `last_seen_at` stayed microsecond-exact — the two
 * precisions no longer disagree.
 *
 * `ensureFrontiers` has to have run for every project in scope, or the join
 * finds nothing and the row falls out.
 *
 * Exported because the inbox's candidate discovery has to compare against the
 * same threshold this file's scans do; a second spelling of the join is the
 * shape the two drifting apart would take.
 */
export function frontierJoin(userId: number, projectId: PgColumn) {
  return and(
    eq(readFrontiers.projectId, projectId),
    eq(readFrontiers.userId, userId),
  );
}

/**
 * Unread state of `issueIds` for `userId`: an issue is unread when someone
 * else commented or acted on it after the user's last-seen position (or the
 * project frontier when the issue was never opened); `counts` carries how
 * many such comments are waiting (T-77 — events mark unread but don't count).
 * The issue itself is the first of those comments when someone else opened it
 * after that position (T-151), so a new card lands as strong unread instead of
 * the weak, event-only kind `show_weak_unread` is allowed to hide.
 * Two thresholded counts plus a grouped-max scan over events — cheap at
 * list-page sizes, and self-healing on comment deletion.
 *
 * `projectIds` is a set because the inbox asks about every project sharing one
 * database in a single pass (T-278). Callers looking at one project pass
 * `[project.id]`; issue ids are unique per database, so nothing crosses.
 */
export async function unreadIssueState(
  db: Db,
  projectIds: number[],
  userId: number,
  issueIds: number[],
  visible: VisibleProjects,
): Promise<{ unread: Set<number>; counts: Map<number, number> }> {
  // Runs even for an empty issue set: creating the frontier is this call's
  // side effect on a project the user has now looked at (T-151), and the
  // joins below have nothing to read without it.
  const frontiers = await ensureFrontiers(db, projectIds, userId);
  if (issueIds.length === 0) return { unread: new Set(), counts: new Map() };

  // The per-issue threshold lives in SQL so the count and the boolean come
  // from one comparison — comparing driver Dates in JS would truncate the
  // stored microseconds and let the two drift on sub-millisecond activity.
  const commentCounts = await db
    .select({ issueId: comments.issueId, n: sql<number>`count(*)` })
    .from(comments)
    .leftJoin(
      issueReads,
      and(
        eq(issueReads.issueId, comments.issueId),
        eq(issueReads.userId, userId),
      ),
    )
    .leftJoin(readFrontiers, frontierJoin(userId, comments.projectId))
    .where(
      and(
        inArray(comments.issueId, issueIds),
        ne(comments.authorId, userId),
        sql`${comments.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    )
    .groupBy(comments.issueId);
  const counts = new Map(commentCounts.map((r) => [r.issueId, Number(r.n)]));

  // The top post, on the same threshold and by the same reasoning — a card
  // is one row, not a group, so it contributes at most 1. Only `created_at`
  // is read: editing a body is a revision event, not a fresh first comment,
  // and must not relight a card the reader has already been through.
  const freshIssues = await db
    .select({ issueId: issues.id })
    .from(issues)
    .leftJoin(
      issueReads,
      and(eq(issueReads.issueId, issues.id), eq(issueReads.userId, userId)),
    )
    .leftJoin(readFrontiers, frontierJoin(userId, issues.projectId))
    .where(
      and(
        inArray(issues.id, issueIds),
        ne(issues.authorId, userId),
        live,
        sql`${issues.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    );
  for (const { issueId } of freshIssues) {
    counts.set(issueId, (counts.get(issueId) ?? 0) + 1);
  }

  // `projectId` comes back so the read-position fallback below knows whose
  // frontier to compare against; it is functionally determined by the issue,
  // so grouping by it splits nothing.
  const latestEvents = await db
    .select({
      issueId: issueEvents.issueId,
      projectId: issueEvents.projectId,
      latest: max(issueEvents.createdAt),
    })
    .from(issueEvents)
    .leftJoin(readFrontiers, frontierJoin(userId, issueEvents.projectId))
    .where(
      and(
        inArray(issueEvents.issueId, issueIds),
        ne(issueEvents.actorId, userId),
        gt(issueEvents.createdAt, readFrontiers.frontierAt),
        // Same predicate the timeline reads under: an event the viewer
        // cannot see must never light the card that carries it.
        crossRefVisibleCondition(visible.slugs, visible.ids),
      ),
    )
    .groupBy(issueEvents.issueId, issueEvents.projectId);

  const unread = new Set(counts.keys());

  const latestForeign = new Map<number, { at: Date; projectId: number }>();
  for (const { issueId, projectId, latest } of latestEvents) {
    if (latest === null || unread.has(issueId)) continue;
    latestForeign.set(issueId, { at: latest, projectId });
  }
  if (latestForeign.size > 0) {
    const readRows = await db
      .select({
        issueId: issueReads.issueId,
        lastSeenAt: issueReads.lastSeenAt,
      })
      .from(issueReads)
      .where(
        and(
          eq(issueReads.userId, userId),
          inArray(issueReads.issueId, [...latestForeign.keys()]),
        ),
      );
    const lastSeen = new Map(readRows.map((r) => [r.issueId, r.lastSeenAt]));
    for (const [issueId, { at, projectId }] of latestForeign) {
      const threshold = lastSeen.get(issueId) ?? frontiers.get(projectId);
      if (threshold !== undefined && at > threshold) unread.add(issueId);
    }
  }
  return { unread, counts };
}

/**
 * Advance the caller's last-seen position on an issue. Monotonic — a late
 * request with an older `up_to` never regresses the position. Private
 * state: no timeline event and no change event, so watching agents stay
 * asleep and other users see nothing. The route does notify the caller's
 * own opt-in connections afterwards, over the `me` event that carries only
 * to this user (T-275) — see services/me-events.ts.
 */
export async function markIssueRead(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  input: IssueReadInput,
): Promise<void> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.mark_read",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, project.id),
        eq(issues.number, number),
        // Nothing in the trash is ever unread, so there is no position to
        // advance on one — not even for the admin looking at it.
        live,
      ),
    );
  const issue = issueRows[0];
  if (!issue) throw new NotFoundError("issue not found");

  const upTo = input.up_to === undefined ? new Date() : new Date(input.up_to);
  await db
    .insert(issueReads)
    .values({
      projectId: project.id,
      issueId: issue.id,
      userId: actor.id,
      lastSeenAt: upTo,
    })
    .onConflictDoUpdate({
      target: [issueReads.issueId, issueReads.userId],
      set: {
        lastSeenAt: sql`greatest(${issueReads.lastSeenAt}, excluded.last_seen_at)`,
      },
    });
}

/**
 * Mark everything read across a scope of projects (T-100) — the inbox's
 * "Mark all read" and a project's own are the same call, told apart by
 * `projects`. Same family as markIssueRead: monotonic, no timeline event,
 * no change event, and the same `me` notification from the route.
 *
 * Advancing the frontier alone would not do it. `unreadIssueState` reads
 * each issue's threshold as `coalesce(issue_reads.last_seen_at, frontier)`,
 * so any issue the caller has ever opened keeps its own older position and
 * stays unread behind a moved frontier — hence both layers, in one
 * transaction per project.
 *
 * Not atomic across projects: databases may differ, so each gets its own
 * transaction and the first failure aborts the rest. Retrying is safe —
 * every write is a `greatest`, so replaying it changes nothing.
 */
export async function bulkMarkRead(
  ctx: AppContext,
  actor: UserRow,
  input: BulkReadInput,
): Promise<void> {
  let scope: ProjectRow[];
  if (input.projects === undefined) {
    scope = await accessibleProjectRows(ctx, actor);
  } else {
    scope = [];
    for (const slug of new Set(input.projects)) {
      const { project } = await requireCapability(
        ctx,
        actor,
        slug,
        "issue.mark_read",
      );
      scope.push(project);
    }
  }

  // Bound as a string with an explicit cast rather than a JS Date: the
  // request may carry sub-millisecond precision that a Date would drop.
  // Absent, each project database dates the sweep by its own clock — they
  // are independent servers under `placement=dedicated`.
  const at =
    input.up_to === undefined ? sql`now()` : sql`${input.up_to}::timestamptz`;

  for (const project of scope) {
    const db = await ctx.router.forProject(routeInfoOf(project));
    await db.transaction(async (tx) => {
      // project_id is not redundant: several projects may share one
      // database (placement=shared), and marking one read must not touch
      // its neighbours.
      await tx
        .update(issueReads)
        .set({ lastSeenAt: sql`greatest(${issueReads.lastSeenAt}, ${at})` })
        .where(
          and(
            eq(issueReads.projectId, project.id),
            eq(issueReads.userId, actor.id),
          ),
        );
      await tx
        .insert(readFrontiers)
        .values({
          projectId: project.id,
          userId: actor.id,
          // A frontier born here floors at now(): seeding it from an older
          // `up_to` would let a mark-read call *create* unread history for
          // someone who had never opened the project, inverting the lazy
          // bootstrap ensureFrontier promises (T-35).
          frontierAt: sql`greatest(now(), ${at})`,
        })
        .onConflictDoUpdate({
          target: [readFrontiers.projectId, readFrontiers.userId],
          // `at`, not `excluded.frontier_at`: the floor above applies only
          // to a frontier that did not exist yet. An existing one honours
          // the requested position exactly, so `up_to` in the past marks
          // only up to there.
          set: {
            frontierAt: sql`greatest(${readFrontiers.frontierAt}, ${at})`,
          },
        });
    });
  }
}
