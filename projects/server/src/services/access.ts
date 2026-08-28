import type { MemberRole } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { projectMembers, projects } from "../db/system-schema.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";

export type ProjectRow = typeof projects.$inferSelect;

const RANK: Record<MemberRole, number> = { reader: 0, writer: 1, admin: 2 };

export async function getProjectBySlug(
  ctx: AppContext,
  slug: string,
): Promise<ProjectRow> {
  const rows = await ctx.router
    .system()
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const row = rows[0];
  if (!row) throw new NotFoundError("project not found");
  return row;
}

export async function projectRoleOf(
  ctx: AppContext,
  project: ProjectRow,
  user: UserRow,
): Promise<MemberRole | null> {
  if (user.isInstanceAdmin) return "admin";
  const rows = await ctx.router
    .system()
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, user.id),
      ),
    );
  return rows[0]?.role ?? null;
}

/**
 * Loads the project and enforces the minimum role. Non-members get a 404
 * (not 403) so project existence is never leaked.
 */
export async function requireProject(
  ctx: AppContext,
  user: UserRow,
  slug: string,
  minRole: MemberRole,
): Promise<{ project: ProjectRow; role: MemberRole }> {
  const project = await getProjectBySlug(ctx, slug);
  const role = await projectRoleOf(ctx, project, user);
  if (role === null) throw new NotFoundError("project not found");
  if (RANK[role] < RANK[minRole]) {
    throw new ForbiddenError(`requires ${minRole} role`);
  }
  return { project, role };
}

/**
 * Same visibility rule as listProjects, but keeping the raw rows so the
 * caller can route to each project's database — what every cross-project
 * `/me/*` endpoint needs (T-97's inbox, T-100's bulk read).
 */
export async function accessibleProjectRows(
  ctx: AppContext,
  user: UserRow,
): Promise<ProjectRow[]> {
  const system = ctx.router.system();
  if (user.isInstanceAdmin) return system.select().from(projects);
  const memberships = await system
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  const ids = memberships.map((m) => m.projectId);
  if (ids.length === 0) return [];
  return system.select().from(projects).where(inArray(projects.id, ids));
}

/** The slugs a viewer may see named — the input to every visibility filter. */
export async function accessibleProjectSlugs(
  ctx: AppContext,
  user: UserRow,
): Promise<string[]> {
  return (await accessibleProjectRows(ctx, user)).map((row) => row.slug);
}

export function routeInfoOf(project: ProjectRow) {
  return {
    id: project.id,
    slug: project.slug,
    database_url: project.databaseUrl,
  };
}
