import type {
  Status,
  StatusCreateInput,
  StatusUpdateInput,
} from "@todou/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { issues, statuses } from "../db/project-schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireProject, routeInfoOf } from "./access.ts";

type StatusRow = typeof statuses.$inferSelect;

export function toStatus(row: StatusRow): Status {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    color: row.color,
    position: row.position,
  };
}

export async function listStatuses(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Status[]> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, project.id))
    .orderBy(asc(statuses.position), asc(statuses.id));
  return rows.map(toStatus);
}

export async function createStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: StatusCreateInput,
): Promise<Status> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
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
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const db = await ctx.router.forProject(routeInfoOf(project));

  if (input.name !== undefined) {
    await ensureNameFree(db, project.id, input.name, statusId);
  }
  const updated = await db
    .update(statuses)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.position === undefined ? {} : { position: input.position }),
    })
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, project.id)))
    .returning();
  const row = updated[0];
  if (!row) throw new NotFoundError("status not found");
  ctx.bus.publish(project.id, {
    entity: "status",
    id: row.id,
    action: "updated",
  });
  return toStatus(row);
}

export async function deleteStatus(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  statusId: number,
): Promise<void> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
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
  return rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
}
