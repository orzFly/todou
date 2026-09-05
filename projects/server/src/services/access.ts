import {
  type CapabilityId,
  type MemberRole,
  minRoleOf,
  ROLE_RANK,
} from "@todou/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { projectMembers, projects, slugHistory } from "../db/system-schema.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";

export type ProjectRow = typeof projects.$inferSelect;

/**
 * A resolved project, and whether the caller reached it by a spelling that is
 * not its current slug — a retired slug, or its id.
 */
export type ProjectLookup = { project: ProjectRow; viaAlias: boolean };

/**
 * A digit run that survives a round trip through a JavaScript number, which
 * is how project ids are carried everywhere else here.
 */
const ID_REF = /^\d{1,15}$/;

/**
 * The single chokepoint every `/projects/{ref}/*` route funnels through, so a
 * retired slug keeps working everywhere at once — attachment downloads and the
 * SSE stream included (T-156). Live slugs answer on the unique index and never
 * touch the history table.
 *
 * An all-digit segment is read as a project id first (T-266): stored links are
 * anchored on the id, so every route has to answer to one. The slug ladder
 * still runs behind it, because a project created before ids were spelled this
 * way may hold an all-digit slug — new ones cannot, and the migration checks
 * that none are left.
 */
export async function findProjectByRef(
  ctx: AppContext,
  ref: string,
): Promise<ProjectLookup | null> {
  const system = ctx.router.system();
  if (ID_REF.test(ref)) {
    const byId = await system
      .select()
      .from(projects)
      .where(eq(projects.id, Number(ref)));
    const row = byId[0];
    // Reached by id, so the canonical spelling for a human is still the slug:
    // same treatment as a retired one, header included.
    if (row) return { project: row, viaAlias: true };
  }
  const rows = await system
    .select()
    .from(projects)
    .where(eq(projects.slug, ref));
  const row = rows[0];
  if (row) return { project: row, viaAlias: false };
  // The most recent holder, which after a reclaim is the project that gave
  // the slug up — whoever took it is current and answered above.
  const historic = await system
    .select({ project: projects })
    .from(slugHistory)
    .innerJoin(projects, eq(projects.id, slugHistory.projectId))
    .where(eq(slugHistory.slug, ref))
    .orderBy(desc(slugHistory.effectiveFrom), desc(slugHistory.id))
    .limit(1);
  const former = historic[0]?.project;
  return former === undefined ? null : { project: former, viaAlias: true };
}

export async function getProjectByRef(
  ctx: AppContext,
  ref: string,
): Promise<ProjectRow> {
  const found = await findProjectByRef(ctx, ref);
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
 *
 * Call `requireCapability` instead: a role passed as a literal here is a
 * requirement written down where neither the permission table nor anyone
 * changing the rules will find it, which is what the catalog exists to end.
 * A test in this package fails on any such call site outside this file.
 */
export async function requireProject(
  ctx: AppContext,
  user: UserRow,
  slug: string,
  minRole: MemberRole,
  cap?: CapabilityId,
): Promise<{ project: ProjectRow; role: MemberRole }> {
  const project = await getProjectByRef(ctx, slug);
  const role = await projectRoleOf(ctx, project, user);
  if (role === null) throw new NotFoundError("project not found");
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    // Naming the capability turns the 403 into the one line of the catalog
    // to go read, rather than a role the reader must then hunt for.
    const detail = cap === undefined ? "" : ` (${cap})`;
    throw new ForbiddenError(`requires ${minRole} role${detail}`);
  }
  return { project, role };
}

/**
 * The gate every `/projects/{slug}/*` write and role-scoped read goes
 * through. The role it demands is not written here but read from the shared
 * capability catalog, so the permission table the UI renders and the check
 * that enforces it cannot disagree.
 */
export async function requireCapability(
  ctx: AppContext,
  user: UserRow,
  slug: string,
  cap: CapabilityId,
): Promise<{ project: ProjectRow; role: MemberRole }> {
  return requireProject(ctx, user, slug, minRoleOf(cap), cap);
}

/**
 * The project a read is addressed to, and the caller's role there if they
 * have one. Unlike `requireProject` it does not turn a missing role away:
 * an address whose thing has since moved elsewhere belongs to whoever can
 * read where it went (T-242), and answering that takes looking the id up in
 * the address book first. Only routes that consult the address book may use
 * this — everywhere else, no role still means not found.
 */
export async function projectForRead(
  ctx: AppContext,
  user: UserRow,
  slug: string,
): Promise<{ project: ProjectRow; role: MemberRole | null }> {
  const project = await getProjectByRef(ctx, slug);
  return { project, role: await projectRoleOf(ctx, project, user) };
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
