import type { MuteList, MuteReason } from "@todou/shared";
import { and, eq, exists, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  comments,
  issueEvents,
  issueMutes,
  issues,
} from "../db/project-schema.ts";
import { projectMutes } from "../db/system-schema.ts";
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
  visibleProjectsOf,
} from "./cross-references.ts";
import { projectIconUrlOf } from "./projects.ts";
import { live } from "./trash.ts";

/** One stored issue mute; `mutedAt` is the `until_activity` boundary. */
export type IssueMute = { mode: "forever" | "until_activity"; mutedAt: Date };

/**
 * Everything the read-side gate needs for one request: which projects the
 * reader muted outright, and their per-issue mute rows. Loaded in two
 * index-only queries; readers with no mutes at all pay the same two, because
 * knowing that is exactly what the queries ask.
 */
export type MuteContext = {
  mutedProjects: Set<number>;
  issueMutes: Map<number, IssueMute>;
};

/**
 * The per-issue half of a MuteContext, with the project half handed in —
 * groupInbox composes this with the one system-db read getInbox already
 * made, so no group re-asks it.
 */
export async function loadIssueMutes(
  db: Db,
  userId: number,
  issueIds: number[],
  mutedProjects: Set<number>,
): Promise<MuteContext> {
  const rows =
    issueIds.length === 0
      ? []
      : await db
          .select({
            issueId: issueMutes.issueId,
            mode: issueMutes.mode,
            mutedAt: issueMutes.mutedAt,
          })
          .from(issueMutes)
          .where(
            and(
              eq(issueMutes.userId, userId),
              inArray(issueMutes.issueId, issueIds),
            ),
          );
  return {
    mutedProjects,
    issueMutes: new Map(
      rows.map((r) => [r.issueId, { mode: r.mode, mutedAt: r.mutedAt }]),
    ),
  };
}

/** Both halves at once; `listIssues` has no caller that pre-reads projects. */
export async function loadMuteContext(
  systemDb: Db,
  db: Db,
  userId: number,
  projectIds: number[],
  issueIds: number[],
): Promise<MuteContext> {
  const [mutedProjects, issueHalf] = await Promise.all([
    loadMutedProjects(systemDb, userId, projectIds),
    loadIssueMutes(db, userId, issueIds, new Set()),
  ]);
  return { mutedProjects, issueMutes: issueHalf.issueMutes };
}

/**
 * One query, many projects — `getInbox` reads this once before fanning out
 * to per-database groups, so no group re-asks the system db.
 */
export async function loadMutedProjects(
  systemDb: Db,
  userId: number,
  projectIds: number[],
): Promise<Set<number>> {
  if (projectIds.length === 0) return new Set();
  const rows = await systemDb
    .select({ projectId: projectMutes.projectId })
    .from(projectMutes)
    .where(
      and(
        eq(projectMutes.userId, userId),
        inArray(projectMutes.projectId, projectIds),
      ),
    );
  return new Set(rows.map((r) => r.projectId));
}

/**
 * The cards among `issueIds` whose `until_activity` snooze has ended: someone
 * else commented, or left an event the reader can see, after `muted_at`
 * (T-573). An ended snooze is no setting at all — the card notifies, the
 * control reads "Notifying", `/me/mutes` drops it — and stays that way after
 * the reader catches up; only a fresh PUT starts another one. The row is
 * left in place rather than deleted by whichever of the many write paths
 * woke it: the next PUT upserts over it, and a read-side check is one place
 * instead of one per write.
 *
 * The comparison runs against the stored `muted_at` in SQL, never a bound JS
 * Date, so µs-precision activity cannot tie with a ms-truncated boundary.
 * Own activity never wakes, and the event filter is the one the unread scan
 * uses, so a reference from a project the reader cannot see does not either.
 */
export async function endedSnoozes(
  db: Db,
  userId: number,
  issueIds: number[],
  visible: VisibleProjects,
): Promise<Set<number>> {
  if (issueIds.length === 0) return new Set();
  const foreignComment = db
    .select({ one: sql`1` })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueMutes.issueId),
        ne(comments.authorId, userId),
        gt(comments.createdAt, issueMutes.mutedAt),
      ),
    );
  const foreignEvent = db
    .select({ one: sql`1` })
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.issueId, issueMutes.issueId),
        ne(issueEvents.actorId, userId),
        gt(issueEvents.createdAt, issueMutes.mutedAt),
        crossRefVisibleCondition(visible.slugs, visible.ids),
      ),
    );
  const rows = await db
    .select({ issueId: issueMutes.issueId })
    .from(issueMutes)
    .where(
      and(
        eq(issueMutes.userId, userId),
        eq(issueMutes.mode, "until_activity"),
        inArray(issueMutes.issueId, issueIds),
        or(exists(foreignComment), exists(foreignEvent)),
      ),
    );
  return new Set(rows.map((r) => r.issueId));
}

/**
 * The read-side gate, in one place (T-372). By the time a mute reaches here
 * an ended snooze has already been dropped (`endedSnoozes`), so every row
 * that remains is in force.
 *
 * This is the seam T-373 ("a mention overrides a mute") extends: one more
 * parameter, one more early return — not a second spelling of the verdict.
 */
export function silenced(
  mute: IssueMute | undefined,
  projectMuted: boolean,
): MuteReason | null {
  if (projectMuted) return "project";
  return mute?.mode ?? null;
}

/**
 * The live row behind one card address, for the mute writes. Trash 404s for
 * the same reason markIssueRead's does: nothing in the trash is ever
 * unread, so there is nothing to quiet either.
 */
async function liveIssueId(
  db: Db,
  projectId: number,
  number: number,
): Promise<number> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(eq(issues.projectId, projectId), eq(issues.number, number), live),
    );
  const row = rows[0];
  if (!row) throw new NotFoundError("issue not found");
  return row.id;
}

/**
 * Idempotent by construction: a repeat PUT lands on the same unique row and
 * pushes `muted_at` to now — "quiet it again" is a real action, and for
 * `until_activity` it is how the reader snoozes again once a snooze has ended.
 */
export async function setIssueMute(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  mode: "forever" | "until_activity",
): Promise<{ project: ProjectRow; issueId: number }> {
  const { project } = await requireCapability(ctx, actor, slug, "issue.mute");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueId = await liveIssueId(db, project.id, number);
  await db
    .insert(issueMutes)
    .values({
      projectId: project.id,
      issueId,
      userId: actor.id,
      mode,
      mutedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [issueMutes.issueId, issueMutes.userId],
      set: {
        mode,
        mutedAt: new Date(),
      },
    });
  return { project, issueId };
}

/** Deleting a mute that is not there is still a success — the state asked for. */
export async function clearIssueMute(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
): Promise<void> {
  const { project } = await requireCapability(ctx, actor, slug, "issue.mute");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const issueId = await liveIssueId(db, project.id, number);
  await db
    .delete(issueMutes)
    .where(
      and(eq(issueMutes.issueId, issueId), eq(issueMutes.userId, actor.id)),
    );
}

export async function setProjectMute(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<void> {
  const { project } = await requireCapability(ctx, actor, slug, "project.mute");
  await ctx.router
    .system()
    .insert(projectMutes)
    .values({ projectId: project.id, userId: actor.id, mutedAt: new Date() })
    .onConflictDoUpdate({
      target: [projectMutes.projectId, projectMutes.userId],
      set: { mutedAt: new Date() },
    });
}

export async function clearProjectMute(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<void> {
  const { project } = await requireCapability(ctx, actor, slug, "project.mute");
  await ctx.router
    .system()
    .delete(projectMutes)
    .where(
      and(
        eq(projectMutes.projectId, project.id),
        eq(projectMutes.userId, actor.id),
      ),
    );
}

/**
 * The settings in force, not today's verdicts: a card that is unread while
 * muted is still listed, because the control on the card and the
 * `/inbox/muted` list both describe what the reader set. A snooze someone
 * else's activity has ended is no setting any more (T-573), so it is not
 * listed and the control falls back to "Notifying".
 *
 * Scope is `accessibleProjectRows`, like an unscoped /me/inbox: a mute on a
 * project the caller can no longer read does not appear. Issue mutes are
 * grouped by database url the way the inbox groups its work, so shared-db
 * projects are one pass.
 */
export async function listMutes(
  ctx: AppContext,
  actor: UserRow,
): Promise<MuteList> {
  const scope = await accessibleProjectRows(ctx, actor);
  const mutedProjects = await loadMutedProjects(
    ctx.router.system(),
    actor.id,
    scope.map((p) => p.id),
  );
  const projectById = new Map(scope.map((p) => [p.id, p]));
  // Only a snooze needs the visibility set, so a reader without one pays
  // nothing for it; one shared promise when several groups hold snoozes.
  let visible: Promise<VisibleProjects> | undefined;

  const projectRows =
    mutedProjects.size === 0
      ? []
      : await ctx.router
          .system()
          .select({
            projectId: projectMutes.projectId,
            mutedAt: projectMutes.mutedAt,
          })
          .from(projectMutes)
          .where(
            and(
              eq(projectMutes.userId, actor.id),
              inArray(projectMutes.projectId, [...mutedProjects]),
            ),
          );

  const groupRows = await ctx.router.perDatabase(
    scope,
    routeInfoOf,
    async (db, group) => {
      const rows = await db
        .select({
          issueId: issueMutes.issueId,
          mode: issueMutes.mode,
          mutedAt: issueMutes.mutedAt,
          number: issues.number,
          title: issues.title,
          projectId: issues.projectId,
        })
        .from(issueMutes)
        .innerJoin(issues, eq(issueMutes.issueId, issues.id))
        .where(
          and(
            eq(issueMutes.userId, actor.id),
            inArray(
              issueMutes.projectId,
              group.map((p) => p.id),
            ),
            // Trash holds no live address to show and Unmute would 404 on
            // it (the writes require `live`): list only what the reader can
            // still act on. The row survives the soft delete and comes back
            // with a restore.
            isNull(issues.deletedAt),
          ),
        );
      const snoozed = rows
        .filter((r) => r.mode === "until_activity")
        .map((r) => r.issueId);
      if (snoozed.length === 0) return rows;
      visible ??= visibleProjectsOf(ctx, scope);
      const ended = await endedSnoozes(db, actor.id, snoozed, await visible);
      return rows.filter((r) => !ended.has(r.issueId));
    },
  );
  const issueOut: MuteList["issues"] = [];
  for (const r of groupRows.flat()) {
    const project = projectById.get(r.projectId);
    if (!project) continue;
    issueOut.push({
      project: { slug: project.slug, name: project.name },
      number: r.number,
      title: r.title,
      mode: r.mode,
      muted_at: r.mutedAt.toISOString(),
    });
  }

  return {
    issues: issueOut,
    projects: projectRows.map((r) => {
      const project = projectById.get(r.projectId);
      return {
        slug: project?.slug ?? "",
        name: project?.name ?? "",
        icon_url: project ? projectIconUrlOf(project) : null,
        muted_at: r.mutedAt.toISOString(),
      };
    }),
  };
}
