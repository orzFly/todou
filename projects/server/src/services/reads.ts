import type { BulkReadInput, IssueReadInput } from "@todou/shared";
import { and, eq, gt, inArray, max, ne, sql } from "drizzle-orm";
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
  requireProject,
  routeInfoOf,
} from "./access.ts";

/**
 * The user's unread epoch in this project, created lazily on first use so
 * history before a user starts reading never counts as unread (T-35's CLI
 * bootstrap semantics). Insert-then-reselect keeps concurrent first calls
 * safe — board columns fire several list queries at once on first load.
 */
export async function ensureFrontier(
  db: Db,
  projectId: number,
  userId: number,
): Promise<Date> {
  const found = await db
    .select({ frontierAt: readFrontiers.frontierAt })
    .from(readFrontiers)
    .where(
      and(
        eq(readFrontiers.projectId, projectId),
        eq(readFrontiers.userId, userId),
      ),
    );
  if (found[0]) return found[0].frontierAt;

  await db
    .insert(readFrontiers)
    .values({ projectId, userId, frontierAt: new Date() })
    .onConflictDoNothing();
  const row = (
    await db
      .select({ frontierAt: readFrontiers.frontierAt })
      .from(readFrontiers)
      .where(
        and(
          eq(readFrontiers.projectId, projectId),
          eq(readFrontiers.userId, userId),
        ),
      )
  )[0];
  if (!row) throw new Error("read frontier missing after insert");
  return row.frontierAt;
}

/**
 * Unread state of `issueIds` for `userId`: an issue is unread when someone
 * else commented or acted on it after the user's last-seen position (or the
 * project frontier when the issue was never opened); `counts` carries how
 * many such comments are waiting (T-77 — events mark unread but don't count).
 * One thresholded count over comments plus a grouped-max scan over events —
 * cheap at list-page sizes, and self-healing on comment deletion.
 */
export async function unreadIssueState(
  db: Db,
  projectId: number,
  userId: number,
  issueIds: number[],
): Promise<{ unread: Set<number>; counts: Map<number, number> }> {
  if (issueIds.length === 0) return { unread: new Set(), counts: new Map() };
  const frontier = await ensureFrontier(db, projectId, userId);

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
    .where(
      and(
        inArray(comments.issueId, issueIds),
        ne(comments.authorId, userId),
        sql`${comments.createdAt} > coalesce(${issueReads.lastSeenAt}, ${frontier})`,
      ),
    )
    .groupBy(comments.issueId);
  const counts = new Map(commentCounts.map((r) => [r.issueId, Number(r.n)]));

  const latestEvents = await db
    .select({
      issueId: issueEvents.issueId,
      latest: max(issueEvents.createdAt),
    })
    .from(issueEvents)
    .where(
      and(
        inArray(issueEvents.issueId, issueIds),
        ne(issueEvents.actorId, userId),
        gt(issueEvents.createdAt, frontier),
      ),
    )
    .groupBy(issueEvents.issueId);

  const unread = new Set(counts.keys());

  const latestForeign = new Map<number, Date>();
  for (const { issueId, latest } of latestEvents) {
    if (latest === null || unread.has(issueId)) continue;
    latestForeign.set(issueId, latest);
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
    for (const [issueId, latest] of latestForeign) {
      if (latest > (lastSeen.get(issueId) ?? frontier)) unread.add(issueId);
    }
  }
  return { unread, counts };
}

/**
 * Advance the caller's last-seen position on an issue. Monotonic — a late
 * request with an older `up_to` never regresses the position. Private
 * state: no timeline event and no SSE, so watching agents stay asleep and
 * other users see nothing.
 */
export async function markIssueRead(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  input: IssueReadInput,
): Promise<void> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueRows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, project.id), eq(issues.number, number)));
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
 * no SSE.
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
      const { project } = await requireProject(ctx, actor, slug, "reader");
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
