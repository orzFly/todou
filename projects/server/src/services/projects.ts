import { rm } from "node:fs/promises";
import type {
  MemberRole,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from "@todou/shared";
import { CANONICAL_STATUSES } from "@todou/shared";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { uniqueViolation } from "../auth/provision.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  attachments,
  autolinks,
  comments,
  issueEvents,
  issues,
  labels,
  projectMeta,
  refFormats,
  statuses,
} from "../db/project-schema.ts";
import { projectMembers, projects, slugHistory } from "../db/system-schema.ts";
import {
  ConflictError,
  SlugReservedError,
  ValidationFailedError,
} from "../errors.ts";
import { type ProjectRow, requireCapability, routeInfoOf } from "./access.ts";
import { mirrorRefFormat } from "./reference-directory.ts";

export function toProject(row: ProjectRow, viewerRole?: MemberRole): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    ...(viewerRole === undefined ? {} : { viewer_role: viewerRole }),
  };
}

/**
 * The three states a target slug can be in, as one check shared by creation
 * and rename: held by someone else (409), held by nobody but still routing
 * to a previous holder (409 unless reclaimed), or free. "Free" includes a
 * slug this very project used to hold, so renaming A→B→A needs no ceremony.
 */
async function checkSlugAvailable(
  system: Db,
  slug: string,
  forProjectId: number | null,
  reclaim: boolean,
): Promise<void> {
  const current = await system
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug));
  const holder = current[0];
  if (holder !== undefined) {
    if (holder.id === forProjectId) return;
    throw new ConflictError(`slug "${slug}" is already taken`);
  }
  if (reclaim) return;
  const previous = await system
    .select({ projectId: slugHistory.projectId })
    .from(slugHistory)
    .where(eq(slugHistory.slug, slug))
    .orderBy(desc(slugHistory.effectiveFrom), desc(slugHistory.id))
    .limit(1);
  const last = previous[0];
  if (last !== undefined && last.projectId !== forProjectId) {
    throw new SlugReservedError(slug);
  }
}

export async function createProject(
  ctx: AppContext,
  actor: UserRow,
  input: ProjectCreateInput,
): Promise<Project> {
  const system = ctx.router.system();

  await checkSlugAvailable(system, input.slug, null, input.reclaim ?? false);

  // The check above races anyone creating the same slug concurrently; the
  // unique index is what actually decides, so translate its verdict rather
  // than letting a lost race surface as a 500.
  const inserted = await system
    .insert(projects)
    .values({
      slug: input.slug,
      name: input.name,
      description: input.description,
    })
    .returning()
    .catch((cause: unknown) => {
      if (uniqueViolation(cause) === null) throw cause;
      throw new ConflictError(`slug "${input.slug}" is already taken`);
    });
  const row = inserted[0];
  if (!row) throw new Error("project insert returned no row");

  try {
    // Anchored at createdAt for the same reason the ref format is: the
    // history has to cover every instant this project could hold content.
    await system.insert(slugHistory).values({
      projectId: row.id,
      slug: row.slug,
      effectiveFrom: row.createdAt,
    });
    const db = await ctx.router.provision(routeInfoOf(row));
    await db
      .insert(projectMeta)
      .values({ projectId: row.id })
      .onConflictDoNothing();
    await db.insert(statuses).values(
      CANONICAL_STATUSES.map((s, i) => ({
        projectId: row.id,
        name: s.name,
        category: s.category,
        color: s.color,
        position: i,
        isDefault: s.is_default ?? false,
      })),
    );
    // Anchored at the registry row's own createdAt, not now(): the history
    // then covers every instant the project could already hold content.
    if (input.ref_prefix != null) {
      await db.insert(refFormats).values({
        projectId: row.id,
        prefix: input.ref_prefix,
        effectiveFrom: row.createdAt,
      });
    }
    await system.insert(projectMembers).values({
      projectId: row.id,
      userId: actor.id,
      role: "admin",
    });
    if (input.ref_prefix != null) {
      await mirrorRefFormat(system, row.id, {
        prefix: input.ref_prefix,
        effectiveFrom: row.createdAt,
      });
    }
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

/**
 * Retired slugs that still route to this project, oldest first. A slug this
 * project gave up and somebody else has since taken is not listed: it no
 * longer comes here, so offering it as an alias would be a lie.
 */
export async function formerSlugsOf(
  system: Db,
  project: ProjectRow,
): Promise<string[]> {
  const mine = await system
    .select({ slug: slugHistory.slug, at: slugHistory.effectiveFrom })
    .from(slugHistory)
    .where(eq(slugHistory.projectId, project.id))
    .orderBy(asc(slugHistory.effectiveFrom), asc(slugHistory.id));
  const heldAt = new Map<string, Date>();
  for (const row of mine) {
    if (row.slug !== project.slug) heldAt.set(row.slug, row.at);
  }
  if (heldAt.size === 0) return [];
  const candidates = [...heldAt.keys()];
  const latest = await system
    .select({
      slug: slugHistory.slug,
      projectId: slugHistory.projectId,
    })
    .from(slugHistory)
    .where(inArray(slugHistory.slug, candidates))
    .orderBy(desc(slugHistory.effectiveFrom), desc(slugHistory.id));
  const holderOf = new Map<string, number>();
  for (const row of latest) {
    if (!holderOf.has(row.slug)) holderOf.set(row.slug, row.projectId);
  }
  return candidates
    .filter((slug) => holderOf.get(slug) === project.id)
    .sort(
      (a, b) =>
        (heldAt.get(a) as Date).getTime() - (heldAt.get(b) as Date).getTime(),
    );
}

export async function listProjects(
  ctx: AppContext,
  user: UserRow,
): Promise<Project[]> {
  const system = ctx.router.system();
  // An instance admin is an admin everywhere without a membership row.
  if (user.isInstanceAdmin) {
    return (await system.select().from(projects)).map((row) =>
      toProject(row, "admin"),
    );
  }
  const memberships = await system
    .select({ projectId: projectMembers.projectId, role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  const ids = memberships.map((m) => m.projectId);
  if (ids.length === 0) return [];
  const roleById = new Map(memberships.map((m) => [m.projectId, m.role]));
  const rows = await system
    .select()
    .from(projects)
    .where(inArray(projects.id, ids));
  return rows.map((row) => toProject(row, roleById.get(row.id)));
}

/**
 * `todou#` autolinks and the slug `todou` claim the same tokens, and the
 * qualified form wins — so a rename into a slug some project already
 * autolinks would silently kill that rule. The mirror check lives in
 * reference-config.ts, which refuses the autolink when the slug exists
 * first. Rules live in each project's own database, so this opens them all;
 * a database that will not open is logged and skipped, because the check is
 * a guard rail rather than a security boundary.
 */
async function assertNoAutolinkShadow(
  ctx: AppContext,
  newSlug: string,
): Promise<void> {
  const prefix = `${newSlug}#`;
  const rows = await ctx.router.system().select().from(projects);
  for (const row of rows) {
    let hits: { id: number }[];
    try {
      const db = await ctx.router.forProject(routeInfoOf(row));
      hits = await db
        .select({ id: autolinks.id })
        .from(autolinks)
        .where(
          and(eq(autolinks.projectId, row.id), eq(autolinks.prefix, prefix)),
        );
    } catch (cause) {
      console.error(`autolink shadow check skipped for ${row.slug}`, cause);
      continue;
    }
    if (hits.length > 0) {
      throw new ValidationFailedError(
        `slug "${newSlug}" would shadow the autolink prefix "${prefix}" ` +
          "configured in this deployment — remove that autolink first",
      );
    }
  }
}

/**
 * A url_template is arbitrary JS (config.ts `compileUrlTemplate`), so
 * whether it reads the slug can only be found out by resolving it both
 * ways. When it does, the project is pinned to the database it is using
 * right now — otherwise the rename would silently reroute it to an empty
 * one. Returns null when there is nothing to pin.
 */
function databaseUrlToPin(
  ctx: AppContext,
  project: ProjectRow,
  newSlug: string,
): string | null {
  if (project.databaseUrl !== null) return null;
  const route = routeInfoOf(project);
  const before = ctx.router.resolveProjectUrl(route);
  const after = ctx.router.resolveProjectUrl({ ...route, slug: newSlug });
  return before === after ? null : before;
}

export async function updateProject(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: ProjectUpdateInput,
): Promise<Project> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "project.update",
  );
  const system = ctx.router.system();
  const rename =
    input.slug !== undefined && input.slug !== project.slug ? input.slug : null;

  let pinnedUrl: string | null = null;
  if (rename !== null) {
    await checkSlugAvailable(
      system,
      rename,
      project.id,
      input.reclaim ?? false,
    );
    await assertNoAutolinkShadow(ctx, rename);
    pinnedUrl = databaseUrlToPin(ctx, project, rename);
  }

  const updated = await system.transaction(async (tx) => {
    if (rename !== null) {
      await tx
        .insert(slugHistory)
        .values({ projectId: project.id, slug: rename });
    }
    return tx
      .update(projects)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(rename === null ? {} : { slug: rename }),
        ...(pinnedUrl === null ? {} : { databaseUrl: pinnedUrl }),
      })
      .where(eq(projects.id, project.id))
      .returning();
  });
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
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "project.delete",
  );
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
