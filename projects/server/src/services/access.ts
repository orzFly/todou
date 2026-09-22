import {
  type CapabilityId,
  type MemberRole,
  minRoleOf,
  PROJECT_NOT_FOUND,
  roleRankOf,
} from "@todou/shared";
import { and, desc, eq, inArray, or } from "drizzle-orm";
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
export async function findProjectsByRefs(
  ctx: AppContext,
  refs: readonly string[],
): Promise<Map<string, ProjectLookup>> {
  const wanted = [...new Set(refs)];
  const found = new Map<string, ProjectLookup>();
  if (wanted.length === 0) return found;
  const system = ctx.router.system();
  const ids = wanted.filter((ref) => ID_REF.test(ref)).map(Number);
  const current = await system
    .select()
    .from(projects)
    .where(or(inArray(projects.id, ids), inArray(projects.slug, wanted)));
  const byId = new Map(current.map((row) => [row.id, row]));
  const bySlug = new Map(current.map((row) => [row.slug, row]));
  const pending: string[] = [];
  for (const ref of wanted) {
    const idRow = ID_REF.test(ref) ? byId.get(Number(ref)) : undefined;
    // Reached by id, so the canonical spelling for a human is still the slug:
    // same treatment as a retired one, header included.
    if (idRow) {
      found.set(ref, { project: idRow, viaAlias: true });
      continue;
    }
    const slugRow = bySlug.get(ref);
    if (slugRow) {
      found.set(ref, { project: slugRow, viaAlias: false });
      continue;
    }
    pending.push(ref);
  }
  if (pending.length === 0) return found;
  const historic = await system
    .select({ slug: slugHistory.slug, project: projects })
    .from(slugHistory)
    .innerJoin(projects, eq(projects.id, slugHistory.projectId))
    .where(inArray(slugHistory.slug, pending))
    .orderBy(desc(slugHistory.effectiveFrom), desc(slugHistory.id));
  for (const row of historic) {
    // First row per slug is the most recent holder, which after a reclaim is
    // the project that gave the slug up — whoever took it is current and
    // answered above.
    if (found.has(row.slug)) continue;
    found.set(row.slug, { project: row.project, viaAlias: true });
  }
  return found;
}

/** One ref through {@link findProjectsByRefs}. */
export async function findProjectByRef(
  ctx: AppContext,
  ref: string,
): Promise<ProjectLookup | null> {
  return (await findProjectsByRefs(ctx, [ref])).get(ref) ?? null;
}

export async function getProjectByRef(
  ctx: AppContext,
  ref: string,
): Promise<ProjectRow> {
  const found = await findProjectByRef(ctx, ref);
  if (!found) throw new NotFoundError(PROJECT_NOT_FOUND);
  return found.project;
}

export async function rolesByProject(
  ctx: AppContext,
  user: UserRow,
  projectIds: readonly number[],
): Promise<Map<number, MemberRole | null>> {
  // Pre-filled so a caller reads `.get(id) ?? null` without having to tell
  // "no membership row" apart from "not asked about".
  const roles = new Map<number, MemberRole | null>(
    projectIds.map((id) => [id, null]),
  );
  if (roles.size === 0) return roles;
  if (user.isInstanceAdmin) {
    for (const id of roles.keys()) roles.set(id, "admin");
    return roles;
  }
  const rows = await ctx.router
    .system()
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, user.id),
        inArray(projectMembers.projectId, [...roles.keys()]),
      ),
    );
  for (const row of rows) roles.set(row.projectId, row.role);
  return roles;
}

export async function projectRoleOf(
  ctx: AppContext,
  project: ProjectRow,
  user: UserRow,
): Promise<MemberRole | null> {
  return (
    (await rolesByProject(ctx, user, [project.id])).get(project.id) ?? null
  );
}

function enforceMinRole(
  role: MemberRole | null,
  minRole: MemberRole,
  cap?: CapabilityId,
): MemberRole {
  if (role === null) throw new NotFoundError(PROJECT_NOT_FOUND);
  const rank = roleRankOf(role);
  const minRank = roleRankOf(minRole);
  if (minRank === undefined) {
    throw new TypeError(`Unknown minimum project role: ${minRole}`);
  }
  if (rank === undefined || rank < minRank) {
    // Naming the capability turns the 403 into the one line of the catalog
    // to go read, rather than a role the reader must then hunt for.
    const detail = cap === undefined ? "" : ` (${cap})`;
    throw new ForbiddenError(`requires ${minRole} role${detail}`);
  }
  return role;
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
  return { project, role: enforceMinRole(role, minRole, cap) };
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

export async function authorizeProjects(
  ctx: AppContext,
  user: UserRow,
  rows: readonly ProjectRow[],
  cap: CapabilityId,
): Promise<ProjectRow[]> {
  const roles = await rolesByProject(
    ctx,
    user,
    rows.map((row) => row.id),
  );
  const minRole = minRoleOf(cap);
  for (const row of rows) {
    enforceMinRole(roles.get(row.id) ?? null, minRole, cap);
  }
  return [...rows];
}

export async function requireCapabilities(
  ctx: AppContext,
  user: UserRow,
  refs: readonly string[],
  cap: CapabilityId,
): Promise<ProjectRow[]> {
  const found = await findProjectsByRefs(ctx, refs);
  const roles = await rolesByProject(
    ctx,
    user,
    [...found.values()].map((lookup) => lookup.project.id),
  );
  const minRole = minRoleOf(cap);
  const out: ProjectRow[] = [];
  for (const ref of refs) {
    // One pass, because the failure a caller sees has to be the first one in
    // their own ordering: resolving every ref up front would turn a 403 on
    // ref #1 into a 404 raised by ref #2.
    const lookup = found.get(ref);
    if (lookup === undefined) throw new NotFoundError(PROJECT_NOT_FOUND);
    enforceMinRole(roles.get(lookup.project.id) ?? null, minRole, cap);
    out.push(lookup.project);
  }
  return out;
}

export function routeInfoOf(project: ProjectRow) {
  return {
    id: project.id,
    slug: project.slug,
    database_url: project.databaseUrl,
  };
}
