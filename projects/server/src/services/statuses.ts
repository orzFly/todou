import {
  INT4_MAX,
  type Status,
  type StatusCreateInput,
  type StatusOrder,
  type StatusOrderInput,
  type StatusUpdateInput,
  type StatusUsage,
} from "@todou/shared";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { issues, projectMeta, statuses } from "../db/project-schema.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationFailedError,
} from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import { announceBlockChanges, reevaluateProjectBlocks } from "./blocks.ts";

type StatusRow = typeof statuses.$inferSelect;

export function toStatus(row: StatusRow): Status {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    color: row.color,
    position: row.position,
    is_default: row.isDefault,
  };
}

export async function listStatuses(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Status[]> {
  const { project } = await requireCapability(ctx, actor, slug, "status.list");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, project.id))
    .orderBy(asc(statuses.position), asc(statuses.id));
  return rows.map(toStatus);
}

export async function listStatusUsage(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<StatusUsage[]> {
  const { project } = await requireCapability(ctx, actor, slug, "status.usage");
  const db = await ctx.router.forProject(routeInfoOf(project));
  return db
    .select({
      id: statuses.id,
      issues: sql<number>`(count(${issues.id}) filter (where ${issues.deletedAt} is null))::int`,
      trashed: sql<number>`(count(${issues.id}) filter (where ${issues.deletedAt} is not null))::int`,
    })
    .from(statuses)
    .leftJoin(issues, eq(issues.statusId, statuses.id))
    .where(eq(statuses.projectId, project.id))
    .groupBy(statuses.id)
    .orderBy(asc(statuses.id));
}

/**
 * The whole order and the clear line in one write (T-712). One drop on the
 * Statuses page can change both — dragging the line's own status above it
 * moves the line to the next one — and as two writes it would reevaluate
 * blocks twice and announce a state nobody arranged.
 */
export async function reorderStatuses(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: StatusOrderInput,
): Promise<StatusOrder> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(statuses)
      .where(eq(statuses.projectId, project.id))
      .orderBy(asc(statuses.position), asc(statuses.id));
    const known = new Set(rows.map((row) => row.id));
    const supplied = new Set(input.ids);
    if (
      supplied.size !== input.ids.length ||
      supplied.size !== known.size ||
      input.ids.some((id) => !known.has(id))
    ) {
      throw new ConflictError("statuses changed — reload");
    }
    const line = input.block_clear_status_id;
    if (typeof line === "number" && !supplied.has(line)) {
      throw new ValidationFailedError("unknown status_id");
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const moved: number[] = [];
    const ordered = [];
    for (const [index, id] of input.ids.entries()) {
      const row = byId.get(id) as StatusRow;
      if (row.position !== index) {
        moved.push(id);
        await tx
          .update(statuses)
          .set({ position: index })
          .where(eq(statuses.id, id));
      }
      ordered.push({ ...row, position: index });
    }

    const meta = await tx
      .select({ lineId: projectMeta.blockClearStatusId })
      .from(projectMeta)
      .where(eq(projectMeta.projectId, project.id));
    const before = meta[0]?.lineId ?? null;
    const after = line === undefined ? before : line;
    if (after !== before) {
      await tx
        .update(projectMeta)
        .set({ blockClearStatusId: after })
        .where(eq(projectMeta.projectId, project.id));
    }
    return { ordered, moved, lineChanged: after !== before, line: after };
  });

  if (result.moved.length > 0 || result.lineChanged) {
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
  }
  for (const id of result.moved) {
    ctx.bus.publish(project.id, { entity: "status", id, action: "updated" });
  }
  if (result.lineChanged) {
    ctx.bus.publish(project.id, {
      entity: "project",
      id: project.id,
      action: "updated",
    });
  }
  return {
    statuses: result.ordered.map(toStatus),
    block_clear_status_id: result.line,
  };
}

export async function createStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: StatusCreateInput,
): Promise<Status> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  await ensureNameFree(db, project.id, input.name);
  const position = input.position ?? (await nextPosition(db, project.id));
  const inserted = await db
    .insert(statuses)
    .values({
      projectId: project.id,
      name: input.name,
      category: input.category,
      color: input.color,
      position,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("status insert returned no row");
  ctx.bus.publish(project.id, {
    entity: "status",
    id: row.id,
    action: "created",
  });
  return toStatus(row);
}

export async function updateStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  statusId: number,
  input: StatusUpdateInput,
): Promise<Status> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  // An UPDATE with no assignments is a driver error, not a no-op (T-730).
  if (Object.values(input).every((v) => v === undefined)) {
    const rows = await db
      .select()
      .from(statuses)
      .where(
        and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)),
      );
    const row = rows[0];
    if (!row) throw new NotFoundError("status not found");
    return toStatus(row);
  }

  if (input.name !== undefined) {
    await ensureNameFree(db, project.id, input.name, statusId);
  }
  const row = await db.transaction(async (tx) => {
    if (input.is_default === true) {
      // Only one default per project: becoming it demotes the previous one.
      await tx
        .update(statuses)
        .set({ isDefault: false })
        .where(
          and(
            eq(statuses.projectId, project.id),
            eq(statuses.isDefault, true),
            ne(statuses.id, statusId),
          ),
        );
    }
    const updated = await tx
      .update(statuses)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.is_default === undefined
          ? {}
          : { isDefault: input.is_default }),
      })
      .where(and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)))
      .returning();
    const updatedRow = updated[0];
    if (!updatedRow) throw new NotFoundError("status not found");
    return updatedRow;
  });
  ctx.bus.publish(project.id, {
    entity: "status",
    id: row.id,
    action: "updated",
  });
  // Both halves of the clear-line rule live in this table, so both edits
  // silently move it (T-377): a reorder changes which side of
  // "at this position or past it" a card falls on, and a category change
  // moves the fallback rule that decides it when no line is configured —
  // which, with every project's line starting NULL, is the default path.
  if (input.position !== undefined || input.category !== undefined) {
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
  }
  return toStatus(row);
}

export async function deleteStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  statusId: number,
): Promise<void> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const db = await ctx.router.forProject(routeInfoOf(project));

  const referencing = await db
    .select({ n: count() })
    .from(issues)
    .where(
      and(eq(issues.projectId, project.id), eq(issues.statusId, statusId)),
    );
  if ((referencing[0]?.n ?? 0) > 0) {
    throw new ConflictError(
      "status is used by existing issues — move them to another status first",
    );
  }
  const meta = await db
    .select({ lineId: projectMeta.blockClearStatusId })
    .from(projectMeta)
    .where(eq(projectMeta.projectId, project.id));
  if ((meta[0]?.lineId ?? null) === statusId) {
    throw new ConflictError(
      "status is this project's block clear line — point it elsewhere first",
    );
  }
  const deleted = await db
    .delete(statuses)
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)))
    .returning({ id: statuses.id });
  if (deleted.length === 0) throw new NotFoundError("status not found");
  ctx.bus.publish(project.id, {
    entity: "status",
    id: statusId,
    action: "deleted",
  });
}

async function ensureNameFree(
  db: Db,
  projectId: number,
  name: string,
  exceptId?: number,
): Promise<void> {
  const rows = await db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.name, name)));
  if (rows.some((r) => r.id !== exceptId)) {
    throw new ConflictError(`status "${name}" already exists`);
  }
}

async function nextPosition(db: Db, projectId: number): Promise<number> {
  const rows = await db
    .select({ position: statuses.position })
    .from(statuses)
    .where(eq(statuses.projectId, projectId));
  const next = rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
  if (next > INT4_MAX) {
    throw new ConflictError(
      "a status already holds the highest position; pass position explicitly",
    );
  }
  return next;
}
