import { rm } from "node:fs/promises";
import type {
  MemberRole,
  Project,
  ProjectBrief,
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
  insightsSettings,
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
import { announceBlockChanges, reevaluateProjectBlocks } from "./blocks.ts";
import { markPendingMirror } from "./pending-mirror.ts";
import { mirrorRefFormat } from "./reference-directory.ts";

/**
 * The icon's URL, or null. Minted with the project's **id** although the
 * route also answers to a slug: a slug can be renamed away, and stored links
 * have been id-anchored since T-266. Accept broadly, write narrowly.
 */
export function projectIconUrlOf(row: ProjectRow): string | null {
  if (!row.iconKey) return null;
  // A fresh key per upload, so the tail cache-busts: the URL changes exactly
  // when the image does.
  const version = row.iconKey.split("/").pop()?.slice(0, 8) ?? "0";
  return `/api/projects/${row.id}/icon?v=${version}`;
}

/** Enough of a project to name it, link to it, and draw it. */
export function toProjectBrief(row: ProjectRow): ProjectBrief {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    icon_url: projectIconUrlOf(row),
  };
}

export function toProject(row: ProjectRow, viewerRole?: MemberRole): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    icon_url: projectIconUrlOf(row),
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

/**
 * Everything a new project owns beyond its registry row, split by tier: the
 * system database holds the slug history and the memberships, the project's
 * own database the rest. Taking both handles as parameters is what lets a
 * colocated create pass the same transaction twice.
 */
async function seedProject(
  system: Db,
  db: Db,
  row: ProjectRow,
  input: ProjectCreateInput,
  actor: UserRow,
): Promise<void> {
  // Anchored at createdAt for the same reason the ref format is: the
  // history has to cover every instant this project could hold content.
  await system.insert(slugHistory).values({
    projectId: row.id,
    slug: row.slug,
    effectiveFrom: row.createdAt,
  });
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
  // A machine creating a project brings its owner in as admin alongside it
  // (T-340). Creation is the one path that writes a membership row without
  // going through the ceiling checks, so without this a machine holding a
  // PAT could make itself an admin of a project its owner has no role in —
  // the invariant broken at the moment of birth. Writing the owner's row
  // instead of refusing the create keeps every existing caller working, and
  // leaves the project with a human admin rather than a lone machine whose
  // role nobody is left able to change.
  //
  // No guard on the actor's kind, deliberately: a machine has always been
  // able to create projects here, and taking that away belongs to a card
  // that can go and look at who would break.
  await system.insert(projectMembers).values(
    actor.kind === "machine" && actor.ownerId !== null
      ? [
          { projectId: row.id, userId: actor.id, role: "admin" as const },
          {
            projectId: row.id,
            userId: actor.ownerId,
            role: "admin" as const,
          },
        ]
      : [{ projectId: row.id, userId: actor.id, role: "admin" as const }],
  );
  if (input.ref_prefix != null) {
    await mirrorRefFormat(system, row.id, {
      prefix: input.ref_prefix,
      effectiveFrom: row.createdAt,
    });
  }
}

/**
 * The registry insert, with the unique index's verdict translated: the
 * availability check races anyone creating the same slug concurrently, so a
 * lost race has to surface as a 409 rather than a 500.
 */
async function insertRegistryRow(
  system: Db,
  input: ProjectCreateInput,
): Promise<ProjectRow> {
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
  return row;
}

export async function createProject(
  ctx: AppContext,
  actor: UserRow,
  input: ProjectCreateInput,
): Promise<Project> {
  const system = ctx.router.system();

  if (ctx.router.newProjectSharesSystemDatabase()) {
    // No `provision` call: for a project resolving to the system database it
    // makes the same comparison and returns without a statement, and calling
    // it from inside the transaction would take a second handle.
    const created = await system.transaction(async (tx) => {
      await checkSlugAvailable(tx, input.slug, null, input.reclaim ?? false);
      const row = await insertRegistryRow(tx, input);
      // The transaction is only sound while both tiers are this one
      // database; a route that says otherwise means rolling the whole
      // create back beats writing project rows into the system tier.
      if (!ctx.router.sharesSystemDatabase(routeInfoOf(row))) {
        throw new Error("project routed out of the system database mid-create");
      }
      await seedProject(tx, tx, row, input, actor);
      return row;
    });
    // After the commit: a subscriber that reacts by reading the project has
    // to find it there.
    ctx.bus.publish(created.id, {
      entity: "project",
      id: created.id,
      action: "created",
    });
    return toProject(created);
  }

  await checkSlugAvailable(system, input.slug, null, input.reclaim ?? false);

  // The check above races anyone creating the same slug concurrently; the
  // unique index is what actually decides, so translate its verdict rather
  // than letting a lost race surface as a 500.
  const row = await insertRegistryRow(system, input);

  try {
    const db = await ctx.router.provision(routeInfoOf(row));
    // Before the authoritative write, and only when there is a prefix to
    // mirror at all (T-511). Inside this try on purpose: a mark that fails
    // must still reach the compensating delete below, or the failed create
    // leaves a registry row with no database behind it. It adds no catch of
    // its own — a failure here is a 5xx, same as any other step.
    if (input.ref_prefix != null) await markPendingMirror(ctx, row);
    await seedProject(system, db, row, input, actor);
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
 * first. Rules live in each project's own database, and failing to read one
 * costs different amounts: a query that errors forfeits only that database's
 * verdict, while a database that will not open at all forfeits the whole
 * pass. Either way the worst case is one autolink rule going quietly
 * inactive until the shadowing slug is renamed away again, which is why the
 * check is allowed to give up — it is a guard rail, not a security boundary.
 * It asks every project in the registry rather than the ones the caller can
 * see, because an autolink in a project they cannot read is shadowed just
 * the same.
 */
async function assertNoAutolinkShadow(
  ctx: AppContext,
  newSlug: string,
): Promise<void> {
  const prefix = `${newSlug}#`;
  const rows = await ctx.router.system().select().from(projects);
  const verdicts = await ctx.router
    .perDatabase(rows, routeInfoOf, async (db, group) => {
      try {
        const hits = await db
          .select({ id: autolinks.id })
          .from(autolinks)
          .where(
            and(
              eq(autolinks.prefix, prefix),
              // Narrowing to the group's own projects is not redundant with
              // asking their database: `deleteProject` leaves autolinks
              // behind, and an orphan row must not block somebody else's
              // rename. It is also what keeps the index in play —
              // `autolinks_project_prefix_idx` leads on project_id.
              inArray(
                autolinks.projectId,
                group.map((row) => row.id),
              ),
            ),
          )
          .limit(1);
        return hits.length > 0;
      } catch (cause) {
        // With the default configuration a postgres project database that
        // cannot be reached does not fail in `openDb` — the pool is lazy —
        // so this is where it surfaces. Not unconditional: `auto_migrate` on
        // (router.ts `shouldAutoMigrate`) makes it throw before the callback
        // runs, and then the outer catch is what sees it.
        console.error(
          `autolink shadow check skipped for ${group.map((row) => row.slug).join(", ")}`,
          cause,
        );
        return false;
      }
    })
    .catch((cause: unknown) => {
      console.error(
        "autolink shadow check skipped: a project database would not open",
        cause,
      );
      return [];
    });
  // Outside both catches. Thrown from the callback it would be swallowed by
  // the one above; thrown inside the `.catch` chain it would be reported as
  // an unopenable database. Either way a real shadow would answer 200.
  if (verdicts.some(Boolean)) {
    throw new ValidationFailedError(
      `slug "${newSlug}" would shadow the autolink prefix "${prefix}" ` +
        "configured in this deployment — remove that autolink first",
    );
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

  // Before the registry write, so a bad status id costs nothing: the column
  // lives in the project's own database and its value names a row there.
  if (input.block_clear_status_id !== undefined) {
    const db = await ctx.router.forProject(routeInfoOf(project));
    if (input.block_clear_status_id !== null) {
      const rows = await db
        .select({ id: statuses.id })
        .from(statuses)
        .where(
          and(
            eq(statuses.id, input.block_clear_status_id),
            eq(statuses.projectId, project.id),
          ),
        );
      if (rows.length === 0) {
        throw new ValidationFailedError("unknown status_id");
      }
    }
    await db
      .update(projectMeta)
      .set({ blockClearStatusId: input.block_clear_status_id })
      .where(eq(projectMeta.projectId, project.id));
    // Moving the line re-decides every edge this project's cards block at
    // once — bounded by the project's edge count, not by its card count.
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
  }

  const registryPatch = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(rename === null ? {} : { slug: rename }),
    ...(pinnedUrl === null ? {} : { databaseUrl: pinnedUrl }),
  };
  // A PATCH may now name nothing the registry holds — the clear line lives
  // in the project's own database — and an UPDATE with no assignments is a
  // driver error rather than a no-op.
  const updated =
    Object.keys(registryPatch).length === 0
      ? [project]
      : await system.transaction(async (tx) => {
          if (rename !== null) {
            await tx
              .insert(slugHistory)
              .values({ projectId: project.id, slug: rename });
          }
          return tx
            .update(projects)
            .set(registryPatch)
            .where(eq(projects.id, project.id))
            .returning();
        });
  const row = updated[0];
  if (!row) throw new Error("project update returned no row");
  ctx.bus.publish(row.id, { entity: "project", id: row.id, action: "updated" });
  return {
    ...toProject(row),
    block_clear_status_id: await blockClearStatusOf(ctx, row),
  };
}

/**
 * The project's clear line (T-377). Read on demand rather than carried by
 * `toProject`, which works off the registry row: this one lives in the
 * project's own database, so a list of projects would pay a query per row —
 * the same reason `former_slugs` is only on the single-project GET.
 */
export async function blockClearStatusOf(
  ctx: AppContext,
  project: ProjectRow,
): Promise<number | null> {
  const db = await ctx.router.forProject(routeInfoOf(project));
  const rows = await db
    .select({ id: projectMeta.blockClearStatusId })
    .from(projectMeta)
    .where(eq(projectMeta.projectId, project.id));
  return rows[0]?.id ?? null;
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
      await db
        .delete(insightsSettings)
        .where(eq(insightsSettings.projectId, project.id));
      await db.delete(statuses).where(eq(statuses.projectId, project.id));
      await db.delete(projectMeta).where(eq(projectMeta.projectId, project.id));
    }
    // The icon blob lives outside every table above, so nothing cascades to
    // it; left behind it would be unreachable storage nobody can name.
    if (project.iconKey) await ctx.storage.delete(project.iconKey);
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
