import {
  type BulkReadInput,
  type BulkReadUndoInput,
  type IssueReadInput,
  type IssuesReadInput,
  type MuteReason,
  Timestamp,
} from "@todou/shared";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issueMentions,
  issueReads,
  issues,
  readFrontiers,
} from "../db/project-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  requireCapabilities,
  requireCapability,
  routeInfoOf,
} from "./access.ts";
import {
  crossRefVisibleCondition,
  type VisibleProjects,
} from "./cross-references.ts";
import { endedSnoozes, type MuteContext, silenced } from "./mutes.ts";
import { microIso } from "./timeline.ts";
import { cardInScope, live } from "./trash.ts";

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
  // Ascending, the same order bulkMarkRead's sweep uses: both statements
  // can hold several of one user's frontier rows mid-insert, and opposite
  // orders deadlock on real postgres (PGlite's single connection hides it).
  const wanted = [...new Set(projectIds)].sort((a, b) => a - b);
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
 *
 * `silenced` (T-372) is a separate layer on top: the unread verdicts above
 * are untouched, and the map only says which of these cards the mute gate
 * currently holds quiet — `unread` staying truthful underneath is what makes
 * "how much piled up while muted" answerable later. A snooze that someone
 * else's activity has already ended is not in force (T-573), whatever the
 * reader has read since.
 */
export async function unreadIssueState(
  db: Db,
  projectIds: number[],
  userId: number,
  issueIds: number[],
  visible: VisibleProjects,
  mutes: MuteContext,
  issueProjects: Map<number, number>,
): Promise<{
  unread: Set<number>;
  counts: Map<number, number>;
  silenced: Map<number, MuteReason>;
  /** Cards carrying a mention of the reader past their threshold (T-373). */
  mentioned: Set<number>;
}> {
  // Runs even for an empty issue set: creating the frontier is this call's
  // side effect on a project the user has now looked at (T-151), and the
  // joins below have nothing to read without it.
  const frontiers = await ensureFrontiers(db, projectIds, userId);
  if (issueIds.length === 0) {
    return {
      unread: new Set(),
      counts: new Map(),
      silenced: new Map(),
      mentioned: new Set(),
    };
  }

  // The per-issue threshold lives in SQL so the count and the boolean come
  // from one comparison — comparing driver Dates in JS would truncate the
  // stored microseconds and let the two drift on sub-millisecond activity.
  const commentCounts = await db
    .select({
      issueId: comments.issueId,
      n: sql<number>`count(*)`,
    })
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
        // An action is a status line (T-575): unread the way an event is,
        // never a comment the reader owes a read.
        eq(comments.kind, "comment"),
        sql`${comments.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    )
    .groupBy(comments.issueId);
  const counts = new Map(commentCounts.map((r) => [r.issueId, Number(r.n)]));

  // Those actions, as weak unread: same threshold as the count above, so an
  // action and a comment posted in the same instant agree on being past it.
  const weakComments = await db
    .selectDistinct({ issueId: comments.issueId })
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
        ne(comments.kind, "comment"),
        sql`${comments.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    );

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
        crossRefVisibleCondition(
          visible.slugs,
          visible.ids,
          visible.cardScoped,
        ),
      ),
    )
    .groupBy(issueEvents.issueId, issueEvents.projectId);

  const unread = new Set([
    ...counts.keys(),
    ...weakComments.map((r) => r.issueId),
  ]);

  const eventLatest = new Map<number, Date>();
  const eventProject = new Map<number, number>();
  const fallbackIds = new Set<number>();
  for (const { issueId, projectId, latest } of latestEvents) {
    if (latest === null) continue;
    eventLatest.set(issueId, latest);
    eventProject.set(issueId, projectId);
    if (!unread.has(issueId)) fallbackIds.add(issueId);
  }
  const lastSeen = new Map<number, Date>();
  if (fallbackIds.size > 0) {
    const readRows = await db
      .select({
        issueId: issueReads.issueId,
        lastSeenAt: issueReads.lastSeenAt,
      })
      .from(issueReads)
      .where(
        and(
          eq(issueReads.userId, userId),
          inArray(issueReads.issueId, [...fallbackIds]),
        ),
      );
    for (const r of readRows) lastSeen.set(r.issueId, r.lastSeenAt);
  }
  for (const issueId of fallbackIds) {
    const at = eventLatest.get(issueId);
    const projectId = eventProject.get(issueId);
    if (at === undefined || projectId === undefined) continue;
    const threshold = lastSeen.get(issueId) ?? frontiers.get(projectId);
    if (threshold !== undefined && at > threshold) unread.add(issueId);
  }

  // The gate itself. A card can only be silenced by its own mute row or by
  // its project being muted, so the per-card work runs over the mute rows
  // and the muted projects' cards, never the whole page — a reader with no
  // mutes computes nothing here, and one with no snooze pays no extra query.
  const silencedOut = new Map<number, MuteReason>();
  const snoozed = [...mutes.issueMutes]
    .filter(([, mute]) => mute.mode === "until_activity")
    .map(([id]) => id);
  const ended =
    snoozed.length === 0
      ? new Set<number>()
      : await endedSnoozes(db, userId, snoozed, visible);
  if (mutes.mutedProjects.size > 0 || mutes.issueMutes.size > 0) {
    // The caller already knows which project each row belongs to — a page
    // built from project rows, a group of them, or the one card an SSE
    // judgement is about — so the gate buys its card→project pairs for
    // free instead of a third query.
    for (const id of issueIds) {
      const projectId = issueProjects.get(id);
      if (projectId === undefined) continue;
      const reason = silenced(
        ended.has(id) ? undefined : mutes.issueMutes.get(id),
        mutes.mutedProjects.has(projectId),
      );
      if (reason !== null) silencedOut.set(id, reason);
    }
  }
  // The mention scan (T-373): a mention is a third, harder grade of unread
  // — it survives `show_weak_unread` and the mute gate, because being
  // named is not "event-only news" the reader opted out of. The one case no
  // existing scan covers: an EDIT that adds an @ produces no new comment
  // and no event, only a row here.
  // The threshold is the same coalesce the comment count uses, as a join —
  // never a bound JS Date, for the µs-precision reason `frontierJoin`
  // records. A muted card's mention still lands in `mentioned` (unread
  // stays truthful under a mute; the inbox decides what to do with it).
  const mentionRows = await db
    .select({ issueId: issueMentions.issueId })
    .from(issueMentions)
    .leftJoin(
      issueReads,
      and(
        eq(issueReads.issueId, issueMentions.issueId),
        eq(issueReads.userId, userId),
      ),
    )
    .leftJoin(readFrontiers, frontierJoin(userId, issueMentions.projectId))
    .where(
      and(
        inArray(issueMentions.issueId, issueIds),
        eq(issueMentions.userId, userId),
        ne(issueMentions.actorId, userId),
        sql`${issueMentions.createdAt} > coalesce(${issueReads.lastSeenAt}, ${readFrontiers.frontierAt})`,
      ),
    );
  const mentioned = new Set(mentionRows.map((r) => r.issueId));
  for (const id of mentioned) unread.add(id);
  return { unread, counts, silenced: silencedOut, mentioned };
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
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.mark_read",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueRows = await db
    .select({ id: issues.id, authorId: issues.authorId })
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
  if (!issue || !cardInScope(issue, actor, role)) {
    throw new NotFoundError("issue not found");
  }

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
        // Read since the sweep, so its undo must leave this card alone — and
        // the position alone cannot say so: `upTo` may predate the sweep's
        // `at` (the CLI's `up_to`, or this server's millisecond Date).
        previousSeenAt: null,
      },
    });
}

/**
 * markIssueRead for several cards of one project at once (T-775), to now.
 * Numbers that name nothing live are skipped rather than refused: a card in
 * the trash has nothing unread, and one somebody else just deleted should
 * not fail the rest of the selection.
 */
export async function markIssuesRead(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: IssuesReadInput,
): Promise<void> {
  const { project, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.mark_read",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = (
    await db
      .select({ id: issues.id, authorId: issues.authorId })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, project.id),
          inArray(issues.number, [...new Set(input.numbers)]),
          live,
        ),
      )
  ).filter((row) => cardInScope(row, actor, role));
  if (rows.length === 0) return;
  // Ascending, so two of these over overlapping cards take the row locks in
  // one order and cannot deadlock each other on real postgres.
  const ids = rows.map((row) => row.id).sort((a, b) => a - b);
  await db
    .insert(issueReads)
    .values(
      ids.map((issueId) => ({
        projectId: project.id,
        issueId,
        userId: actor.id,
        lastSeenAt: sql`now()`,
      })),
    )
    .onConflictDoUpdate({
      target: [issueReads.issueId, issueReads.userId],
      set: {
        lastSeenAt: sql`greatest(${issueReads.lastSeenAt}, excluded.last_seen_at)`,
        // As in markIssueRead: read since the sweep, so its undo must leave
        // these cards alone, and `now()` still predates a sweep sent a later
        // `up_to`.
        previousSeenAt: null,
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
 * transaction per database.
 *
 * Positions only move forward, and each one the sweep moves keeps the value
 * it pushed away in `previous_*` for undoBulkMarkRead (T-814). The result is
 * the undo token: every project whose frontier this sweep created or moved,
 * with the sweep's `at` there.
 *
 * Not atomic across databases: no transaction spans them, so a failure can
 * leave some databases swept and others untouched, and the error does not
 * say which. Retrying is safe: a database the failed attempt already swept
 * stands at that attempt's `at`, earlier than the retry's, so it is pushed
 * again and `previous_*` becomes the failed attempt's `at` — undoing that row
 * then reaches back only that far, one level as always.
 */
export async function bulkMarkRead(
  ctx: AppContext,
  actor: UserRow,
  input: BulkReadInput,
): Promise<string> {
  let scope: ProjectRow[];
  if (input.projects === undefined) {
    // Card-scoped projects included (T-788) with no per-card filter: both
    // writes below touch only the caller's own read positions, and on such
    // a project those only ever exist for its own cards.
    scope = await accessibleProjectRows(ctx, actor, { cardScoped: "filter" });
  } else {
    scope = await requireCapabilities(
      ctx,
      actor,
      [...new Set(input.projects)],
      "issue.mark_read",
    );
  }

  // Bound as a string with an explicit cast rather than a JS Date: the
  // request may carry sub-millisecond precision that a Date would drop.
  // Absent, each project database dates the sweep by its own clock — they
  // are independent servers under `placement=dedicated`. One transaction per
  // database makes that clock one reading: a comment landing mid-sweep is
  // read in all of a database's projects or in none of them, never in one
  // and not the neighbour beside it.
  const at =
    input.up_to === undefined ? sql`now()` : sql`${input.up_to}::timestamptz`;

  const moved = await ctx.router.perDatabase(
    scope,
    routeInfoOf,
    async (db, group) => {
      // Deduplicated because one project can reach `scope` twice — its id
      // and its slug both resolve to it (T-266), as does a retired slug — and
      // one INSERT may not name the same conflict key twice. Ascending
      // because this transaction now holds several of the caller's frontier
      // rows at once and `ensureFrontiers` inserts in the same order: two
      // callers taking them in opposite orders deadlock on real postgres.
      const ids = [...new Set(group.map((p) => p.id))].sort((a, b) => a - b);
      return db.transaction(async (tx) => {
        // project_id is not redundant: several projects may share one
        // database (placement=shared), and marking these read must not touch
        // their neighbours. A row already at or past `at` keeps its
        // `previous_seen_at` too: this sweep moved nothing there to undo.
        // Postgres evaluates every SET expression against the old row, so
        // `previous_seen_at` takes the position being overwritten.
        await tx
          .update(issueReads)
          .set({
            previousSeenAt: sql`${issueReads.lastSeenAt}`,
            lastSeenAt: at,
          })
          .where(
            and(
              inArray(issueReads.projectId, ids),
              eq(issueReads.userId, actor.id),
              lt(issueReads.lastSeenAt, at),
            ),
          );
        // `at` comes back as the database's text rather than a Date: the
        // undo matches positions exactly, and a Date would drop the
        // microseconds (T-278).
        return tx
          .insert(readFrontiers)
          .values(
            ids.map((projectId) => ({
              projectId,
              userId: actor.id,
              // A frontier born here floors at now(): seeding it from an
              // older `up_to` would let a mark-read call *create* unread
              // history for someone who had never opened the project,
              // inverting the lazy bootstrap ensureFrontier promises (T-35).
              frontierAt: sql`greatest(now(), ${at})`,
            })),
          )
          .onConflictDoUpdate({
            target: [readFrontiers.projectId, readFrontiers.userId],
            // `at`, not `excluded.frontier_at`: the floor above applies only
            // to a frontier that did not exist yet. An existing one honours
            // the requested position exactly, so `up_to` in the past marks
            // only up to there.
            set: {
              previousFrontierAt: sql`${readFrontiers.frontierAt}`,
              frontierAt: at,
            },
            setWhere: lt(readFrontiers.frontierAt, at),
          })
          .returning({ projectId: readFrontiers.projectId, at: microIso(at) });
      });
    },
  );
  return encodeUndo(moved.flat().map((row) => [row.projectId, row.at]));
}

/**
 * Put back what one bulkMarkRead moved (T-814), in each project of its token
 * the caller can still read; the rest are skipped. Returns those projects'
 * slugs for the route's `reads_swept` notification.
 *
 * A row goes back only while its position still equals the sweep's `at`
 * and its `previous_*` is still set, and both conditions are needed. The
 * position alone would take back a card read since the sweep: the CLI's
 * `up_to` and markIssueRead's millisecond Date can both predate `at`, and
 * `greatest` leaves such a read at `at` — so every read clears
 * `previous_seen_at` instead. `previous_*` alone would let an earlier
 * sweep's token undo a later one, whose `previous_*` that row now holds.
 *
 * Like the sweep, not atomic across databases. Retrying is safe: a row
 * already put back has its `previous_*` cleared.
 */
export async function undoBulkMarkRead(
  ctx: AppContext,
  actor: UserRow,
  input: BulkReadUndoInput,
): Promise<string[]> {
  const wanted = decodeUndo(input.undo);
  const scope = (
    await accessibleProjectRows(ctx, actor, { cardScoped: "filter" })
  ).filter((p) => wanted.has(p.id));
  if (scope.length === 0) return [];

  await ctx.router.perDatabase(scope, routeInfoOf, async (db, group) => {
    const ats = [...new Set(group.map((p) => p.id))].map((id) => ({
      id,
      at: sql`${wanted.get(id)}::timestamptz`,
    }));
    await db.transaction(async (tx) => {
      await tx
        .update(issueReads)
        .set({
          lastSeenAt: sql`${issueReads.previousSeenAt}`,
          previousSeenAt: null,
        })
        .where(
          and(
            eq(issueReads.userId, actor.id),
            isNotNull(issueReads.previousSeenAt),
            or(
              ...ats.map(({ id, at }) =>
                and(
                  eq(issueReads.projectId, id),
                  eq(issueReads.lastSeenAt, at),
                ),
              ),
            ),
          ),
        );
      await tx
        .update(readFrontiers)
        .set({
          frontierAt: sql`${readFrontiers.previousFrontierAt}`,
          previousFrontierAt: null,
        })
        .where(
          and(
            eq(readFrontiers.userId, actor.id),
            isNotNull(readFrontiers.previousFrontierAt),
            or(
              ...ats.map(({ id, at }) =>
                and(
                  eq(readFrontiers.projectId, id),
                  eq(readFrontiers.frontierAt, at),
                ),
              ),
            ),
          ),
        );
    });
  });
  return scope.map((p) => p.slug);
}

/** What a sweep's undo token carries; see encodeUndo. */
const ReadUndoToken = z.strictObject({
  v: z.literal(1),
  at: z.array(z.tuple([z.number().int().positive(), Timestamp])),
});

/**
 * base64url JSON, opaque to clients. Each project carries the `at` its own
 * database wrote, as microsecond text: databases date a sweep by their own
 * clocks, and the undo needs the exact value.
 */
function encodeUndo(at: [number, string][]): string {
  return Buffer.from(JSON.stringify({ v: 1, at })).toString("base64url");
}

/** Project id → the sweep's `at` there; any malformed token is a 422. */
function decodeUndo(raw: string): Map<number, string> {
  let token: z.infer<typeof ReadUndoToken>;
  try {
    token = ReadUndoToken.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
  } catch {
    throw new ValidationFailedError("malformed undo token");
  }
  return new Map(token.at);
}
