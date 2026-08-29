import type { MemberRole } from "@todou/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { projectMembers, projects, slugHistory } from "../db/system-schema.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";

export type ProjectRow = typeof projects.$inferSelect;

const RANK: Record<MemberRole, number> = { reader: 0, writer: 1, admin: 2 };

/** A resolved project, and whether the caller reached it by a retired slug. */
export type ProjectLookup = { project: ProjectRow; viaAlias: boolean };

/**
 * The single chokepoint every `/projects/{slug}/*` route funnels through, so
 * a retired slug keeps working everywhere at once — attachment downloads and
 * the SSE stream included (T-156). Live slugs answer on the unique index and
 * never touch the history table.
 */
export async function findProjectBySlug(
  ctx: AppContext,
  slug: string,
): Promise<ProjectLookup | null> {
  const system = ctx.router.system();
  const rows = await system
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const row = rows[0];
  if (row) return { project: row, viaAlias: false };
  // The most recent holder, which after a reclaim is the project that gave
  // the slug up — whoever took it is current and answered above.
  const historic = await system
    .select({ project: projects })
    .from(slugHistory)
    .innerJoin(projects, eq(projects.id, slugHistory.projectId))
    .where(eq(slugHistory.slug, slug))
    .orderBy(desc(slugHistory.effectiveFrom), desc(slugHistory.id))
    .limit(1);
  const former = historic[0]?.project;
  return former === undefined ? null : { project: former, viaAlias: true };
}

export async function getProjectBySlug(
  ctx: AppContext,
  slug: string,
): Promise<ProjectRow> {
  const found = await findProjectBySlug(ctx, slug);
  if (!found) throw new NotFoundError("project not found");
  return found.project;
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

export function routeInfoOf(project: ProjectRow) {
  return {
    id: project.id,
    slug: project.slug,
    database_url: project.databaseUrl,
  };
}
