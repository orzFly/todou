import type { UserRef } from "@todou/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../../auth/pat.ts";
import type { AppContext } from "../../bootstrap.ts";
import type { Db } from "../../db/driver.ts";
import {
  issueAssignees,
  issueLabels,
  type issues,
  labels,
  statuses,
} from "../../db/project-schema.ts";
import { projectMembers } from "../../db/system-schema.ts";
import { ForbiddenError, ValidationFailedError } from "../../errors.ts";
import { type ProjectRow, requireCapability, routeInfoOf } from "../access.ts";
import { loadIssueRow } from "../issues.ts";
import { lineageOf, tombstoneNumberOf } from "../relocation.ts";
import { assertIssueWritable } from "../trash.ts";
import { getUserRefs } from "../users.ts";

type IssueRow = typeof issues.$inferSelect;
type StatusRow = typeof statuses.$inferSelect;

export type MovePlan = {
  source: { project: ProjectRow; db: Db };
  target: { project: ProjectRow; db: Db };
  row: IssueRow;
  status: { from: StatusRow; to: StatusRow };
  labelIds: number[];
  assigneeIds: number[];
  dropped: { labels: string[]; assignees: UserRef[] };
  /** The number a tombstone still holds in the target; null = take a new one. */
  reinhabit: number | null;
  lineage: number | null;
  /**
   * One timestamp for the whole move: the freeze, the tombstone and both
   * timeline events. Shared so the recovery sweep can prove a freeze is the
   * one its own registration row started.
   */
  movedAt: Date;
  /**
   * Both projects' tables share a database, so the source attachment rows
   * must go before the copies land — `attachments_storage_key_idx` is unique
   * per database and the copy keeps the key.
   */
  sameProjectDb: boolean;
  /** …and the system tables are in there too, so one transaction covers all. */
  systemColocated: boolean;
};

/**
 * Everything decided before anything is written: permissions, the conflicts
 * that refuse the move, the field mapping, whether a tombstone is being
 * moved back into, and which of the two execution paths applies.
 *
 * `dry_run` returns after exactly this, which is the only way a preview can
 * be trusted to match what the move will do.
 */
export async function planMove(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  number: number,
  toSlug: string,
): Promise<MovePlan> {
  const { project: source, role } = await requireCapability(
    ctx,
    actor,
    slug,
    "issue.move",
  );
  const sourceDb = await ctx.router.forProject(routeInfoOf(source));
  const row = await loadIssueRow(sourceDb, source.id, number);
  // Trash, tombstone and freeze all refuse here, with their own codes.
  assertIssueWritable(row, actor, role);
  if (role !== "admin" && row.authorId !== actor.id) {
    throw new ForbiddenError(
      "only the author or a project admin may move an issue",
    );
  }

  // A project the mover cannot see is a 404 from here, same as anywhere.
  const { project: target } = await requireCapability(
    ctx,
    actor,
    toSlug,
    "issue.move_in",
  );
  if (target.id === source.id) {
    throw new ValidationFailedError("that issue is already in this project");
  }
  const targetDb = await ctx.router.forProject(routeInfoOf(target));

  const status = await mapStatus(sourceDb, targetDb, source.id, target.id, row);
  const labelMap = await mapLabels(sourceDb, targetDb, target.id, row);
  const assigneeMap = await mapAssignees(ctx, sourceDb, target.id, row);

  const lineage = await lineageOf(ctx.router.system(), source.id, number);
  const reinhabit =
    lineage === null
      ? null
      : await tombstoneNumberOf(ctx.router.system(), lineage, target.id);

  // Two independent questions. Collapsing them into one would misjudge the
  // deployment where A and B share a dedicated database while the system
  // tables live elsewhere: that needs the protocol, but it also needs the
  // source attachment rows deleted before the copies go in.
  const sourceUrl = ctx.router.resolveProjectUrl(routeInfoOf(source));
  const targetUrl = ctx.router.resolveProjectUrl(routeInfoOf(target));
  const systemUrl = ctx.router.systemHandle().url;

  return {
    source: { project: source, db: sourceDb },
    target: { project: target, db: targetDb },
    row,
    status,
    labelIds: labelMap.ids,
    assigneeIds: assigneeMap.ids,
    dropped: { labels: labelMap.dropped, assignees: assigneeMap.dropped },
    reinhabit,
    lineage,
    movedAt: new Date(),
    sameProjectDb: sourceUrl === targetUrl,
    systemColocated: sourceUrl === systemUrl && targetUrl === systemUrl,
  };
}

/**
 * The status ladder: same name, else the same category's default, else that
 * category's first by position, else the target's own default. Deterministic
 * and total — a move never fails because the target spells its columns
 * differently.
 */
async function mapStatus(
  sourceDb: Db,
  targetDb: Db,
  sourceId: number,
  targetId: number,
  row: IssueRow,
): Promise<{ from: StatusRow; to: StatusRow }> {
  const fromRows = await sourceDb
    .select()
    .from(statuses)
    .where(
      and(eq(statuses.projectId, sourceId), eq(statuses.id, row.statusId)),
    );
  const from = fromRows[0];
  if (from === undefined) throw new Error("issue has unknown status");

  const candidates = await targetDb
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, targetId))
    .orderBy(
      desc(statuses.isDefault),
      asc(statuses.position),
      asc(statuses.id),
    );
  if (candidates.length === 0) {
    throw new ValidationFailedError("the target project has no statuses");
  }

  const sameCategory = candidates.filter((s) => s.category === from.category);
  const to =
    candidates.find((s) => s.name === from.name) ??
    sameCategory.find((s) => s.isDefault) ??
    sameCategory[0] ??
    (candidates[0] as StatusRow);
  return { from, to };
}

async function mapLabels(
  sourceDb: Db,
  targetDb: Db,
  targetId: number,
  row: IssueRow,
): Promise<{ ids: number[]; dropped: string[] }> {
  const current = await sourceDb
    .select({ name: labels.name })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, row.id));
  if (current.length === 0) return { ids: [], dropped: [] };

  const names = current.map((l) => l.name);
  const matched = await targetDb
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(and(eq(labels.projectId, targetId), inArray(labels.name, names)));
  const byName = new Map(matched.map((l) => [l.name, l.id]));
  return {
    ids: names.map((n) => byName.get(n)).filter((id) => id !== undefined),
    dropped: names.filter((n) => !byName.has(n)),
  };
}

async function mapAssignees(
  ctx: AppContext,
  sourceDb: Db,
  targetId: number,
  row: IssueRow,
): Promise<{ ids: number[]; dropped: UserRef[] }> {
  const current = await sourceDb
    .select({ userId: issueAssignees.userId })
    .from(issueAssignees)
    .where(eq(issueAssignees.issueId, row.id));
  if (current.length === 0) return { ids: [], dropped: [] };

  const ids = current.map((a) => a.userId);
  const members = await ctx.router
    .system()
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, targetId),
        inArray(projectMembers.userId, ids),
      ),
    );
  // Filtered, not rejected: an assignee who is not a member of the target is
  // reported as dropped rather than blocking the move.
  const keep = new Set(members.map((m) => m.userId));
  const droppedIds = ids.filter((id) => !keep.has(id));
  const refs = await getUserRefs(ctx.router.system(), droppedIds);
  return {
    ids: ids.filter((id) => keep.has(id)),
    dropped: droppedIds.map(
      (id) =>
        refs.get(id) ?? {
          id,
          login: "ghost",
          display_name: "Deleted user",
          kind: "human" as const,
          avatar_url: null,
          owner: null,
        },
    ),
  };
}
