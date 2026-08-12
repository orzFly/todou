import type { IssueReadInput } from "@todou/shared";
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
import { requireProject, routeInfoOf } from "./access.ts";

/**
 * The user's unread epoch in this project, created lazily on first use so
 * history before a user starts reading never counts as unread (#35's CLI
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
 * Which of `issueIds` are unread for `userId`: any comment/event by someone
 * else, newer than the user's last-seen position (or the project frontier
 * when the issue was never opened). Two grouped-max scans over the page's
 * ids — cheap at list-page sizes, and self-healing on comment deletion.
 */
export async function unreadIssueIds(
  db: Db,
  projectId: number,
  userId: number,
  issueIds: number[],
): Promise<Set<number>> {
  if (issueIds.length === 0) return new Set();
  const frontier = await ensureFrontier(db, projectId, userId);

  const latestComments = await db
    .select({ issueId: comments.issueId, latest: max(comments.createdAt) })
    .from(comments)
    .where(
      and(
        inArray(comments.issueId, issueIds),
        ne(comments.authorId, userId),
        gt(comments.createdAt, frontier),
      ),
    )
    .groupBy(comments.issueId);
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

  const latestForeign = new Map<number, Date>();
  for (const { issueId, latest } of [...latestComments, ...latestEvents]) {
    if (latest === null) continue;
    const prev = latestForeign.get(issueId);
    if (prev === undefined || latest > prev) latestForeign.set(issueId, latest);
  }
  if (latestForeign.size === 0) return new Set();

  const readRows = await db
    .select({ issueId: issueReads.issueId, lastSeenAt: issueReads.lastSeenAt })
    .from(issueReads)
    .where(
      and(
        eq(issueReads.userId, userId),
        inArray(issueReads.issueId, [...latestForeign.keys()]),
      ),
    );
  const lastSeen = new Map(readRows.map((r) => [r.issueId, r.lastSeenAt]));

  const unread = new Set<number>();
  for (const [issueId, latest] of latestForeign) {
    if (latest > (lastSeen.get(issueId) ?? frontier)) unread.add(issueId);
  }
  return unread;
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
