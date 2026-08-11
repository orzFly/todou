import { rm } from "node:fs/promises";
import type {
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from "@todou/shared";
import { eq, inArray, ne } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  attachments,
  comments,
  issueEvents,
  issues,
  labels,
  projectMeta,
  statuses,
} from "../db/project-schema.ts";
import { projectMembers, projects } from "../db/system-schema.ts";
import { ConflictError } from "../errors.ts";
import { type ProjectRow, requireProject, routeInfoOf } from "./access.ts";

const DEFAULT_STATUSES = [
  { name: "Todo", category: "open", color: "#6b7280", position: 0 },
  { name: "In Progress", category: "open", color: "#3b82f6", position: 1 },
  { name: "Done", category: "closed", color: "#22c55e", position: 2 },
] as const;

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    created_at: row.createdAt.toISOString(),
  };
}

export async function createProject(
  ctx: AppContext,
  actor: UserRow,
  input: ProjectCreateInput,
): Promise<Project> {
  const system = ctx.router.system();

  const existing = await system
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, input.slug));
  if (existing.length > 0) {
    throw new ConflictError(`slug "${input.slug}" is already taken`);
  }

  const inserted = await system
    .insert(projects)
    .values({
      slug: input.slug,
      name: input.name,
      description: input.description,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("project insert returned no row");

  try {
    const db = await ctx.router.provision(routeInfoOf(row));
    await db
      .insert(projectMeta)
      .values({ projectId: row.id })
      .onConflictDoNothing();
    await db
      .insert(statuses)
      .values(DEFAULT_STATUSES.map((s) => ({ ...s, projectId: row.id })));
    await system.insert(projectMembers).values({
      projectId: row.id,
      userId: actor.id,
      role: "admin",
    });
  } catch (cause) {
    // Cross-database creation cannot be one transaction; compensate by
    // removing the registry row so the failed project is unroutable.
    await system.delete(projects).where(eq(projects.id, row.id));
    throw cause;
  }

  ctx.bus.publish(row.id, {
    entity: "project",
    id: row.id,
    action: "created",
  });
  return toProject(row);
}

export async function listProjects(
  ctx: AppContext,
  user: UserRow,
): Promise<Project[]> {
  const system = ctx.router.system();
  if (user.isInstanceAdmin) {
    return (await system.select().from(projects)).map(toProject);
  }
  const memberships = await system
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  const ids = memberships.map((m) => m.projectId);
  if (ids.length === 0) return [];
  const rows = await system
    .select()
    .from(projects)
    .where(inArray(projects.id, ids));
  return rows.map(toProject);
}

export async function updateProject(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: ProjectUpdateInput,
): Promise<Project> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const updated = await ctx.router
    .system()
    .update(projects)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
    })
    .where(eq(projects.id, project.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("project update returned no row");
  ctx.bus.publish(row.id, { entity: "project", id: row.id, action: "updated" });
  return toProject(row);
}

export async function deleteProject(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<void> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const system = ctx.router.system();
  const url = ctx.router.resolveProjectUrl(routeInfoOf(project));

  // Remove the registry row FIRST so the project stops routing; cleanup
  // failures below only leave orphaned data behind (logged, not fatal).
  await system.delete(projects).where(eq(projects.id, project.id));

  try {
    const others = (
      await system
        .select({
          id: projects.id,
          slug: projects.slug,
          databaseUrl: projects.databaseUrl,
        })
        .from(projects)
        .where(ne(projects.id, project.id))
    ).map((p) => ({ id: p.id, slug: p.slug, database_url: p.databaseUrl }));

    const exclusivePgliteFile =
      url.startsWith("pglite://") &&
      !url.startsWith("pglite://memory") &&
      url !== ctx.router.systemHandle().url &&
      !ctx.router.isUrlShared(url, others);

    if (exclusivePgliteFile) {
      await ctx.router.closeUrl(url);
      await rm(url.slice("pglite://".length), { recursive: true, force: true });
    } else {
      const db = await ctx.router.forProject(routeInfoOf(project));
      // issues cascade to assignees/labels/comments/events/attachments.
      await db.delete(issues).where(eq(issues.projectId, project.id));
      await db.delete(comments).where(eq(comments.projectId, project.id));
      await db.delete(issueEvents).where(eq(issueEvents.projectId, project.id));
      await db.delete(attachments).where(eq(attachments.projectId, project.id));
      await db.delete(labels).where(eq(labels.projectId, project.id));
      await db.delete(statuses).where(eq(statuses.projectId, project.id));
      await db.delete(projectMeta).where(eq(projectMeta.projectId, project.id));
    }
  } catch (cause) {
    console.error(
      `project ${project.slug} deleted from registry but data cleanup failed`,
      cause,
    );
  }
  ctx.bus.publish(project.id, {
    entity: "project",
    id: project.id,
    action: "deleted",
  });
}
