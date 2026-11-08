import {
  type AccessDenial,
  type AccessHint,
  parseRefLocator,
  resolveClaim,
} from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  projectAccessDenials,
  projectAccessRequests,
  projectMembers,
  users,
} from "../db/system-schema.ts";
import { NotFoundError, ValidationFailedError } from "../errors.ts";
import { findProjectByRef, requireCapability } from "./access.ts";
import { globalPrefixDirectory } from "./reference-directory.ts";
import { getUserRefs } from "./users.ts";

/**
 * "Stop asking me for access to this project" (T-280), stored per project so
 * every spelling of it is covered at once.
 *
 * Writes announce themselves as a `member` event rather than under a name of
 * their own: `ChangeEntity` is a zod enum, so a new value would make pages
 * still open from before a deploy fail to parse the frame. A denial is a fact
 * about project access, which is what that branch already refetches.
 */

export async function listDenials(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<AccessDenial[]> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "access_denial.list",
  );
  const system = ctx.router.system();
  const recorded = await system
    .select()
    .from(projectAccessDenials)
    .where(eq(projectAccessDenials.projectId, project.id));
  // A row naming an agent with no tie here is one only an older server could
  // have written; listing it would read out a stranger's login and owner.
  const tied = await tiedAgents(
    ctx,
    project.id,
    recorded.map((row) => row.userId),
  );
  const rows = recorded.filter((row) => tied.has(row.userId));
  const refs = await getUserRefs(
    system,
    rows.flatMap((row) => [row.userId, row.deniedBy]),
  );
  return rows.map((row) => ({
    // biome-ignore lint/style/noNonNullAssertion: getUserRefs covers all ids
    user: refs.get(row.userId)!,
    // biome-ignore lint/style/noNonNullAssertion: getUserRefs covers all ids
    denied_by: refs.get(row.deniedBy)!,
    created_at: row.createdAt.toISOString(),
  }));
}

export async function setDenial(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  userId: number,
): Promise<void> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "access_denial.set",
  );
  const system = ctx.router.system();

  // Anyone may open a project and become its reader, so "no such account",
  // "a person" and "an agent with no tie here" must be one answer (T-657),
  // or this becomes a census of the instance. Only a member — someone the
  // caller can already see on the members page — is told they are a person.
  if (!(await tiedAgents(ctx, project.id, [userId])).has(userId)) {
    const member = await system
      .select({ kind: users.kind })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          eq(projectMembers.userId, userId),
        ),
      );
    // Agents only. A human asking for access says so in words and is
    // answered in words; this record exists to silence a hint printed by a
    // program, and there is no such hint for a person to silence.
    if (member[0]?.kind === "human") {
      throw new ValidationFailedError("only agents can be denied access");
    }
    throw new NotFoundError("user not found");
  }

  await system
    .insert(projectAccessDenials)
    .values({ projectId: project.id, userId, deniedBy: actor.id })
    .onConflictDoUpdate({
      target: [projectAccessDenials.projectId, projectAccessDenials.userId],
      set: { deniedBy: actor.id, createdAt: new Date() },
    });
  ctx.bus.publish(project.id, {
    entity: "member",
    id: userId,
    action: "updated",
  });
}

/**
 * Which of `userIds` are agents this project may deny: ones whose owner is a
 * member, and ones that have asked the hint endpoint about it. The second is
 * the case the feature exists for — an agent from outside whose owner nobody
 * here knows — and the first lets a member pre-empt an agent of their own.
 */
async function tiedAgents(
  ctx: AppContext,
  projectId: number,
  userIds: number[],
): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const system = ctx.router.system();
  const agents = await system
    .select({ id: users.id, ownerId: users.ownerId })
    .from(users)
    .where(and(inArray(users.id, userIds), eq(users.kind, "machine")));
  if (agents.length === 0) return new Set();
  const ownerIds = agents.flatMap((a) =>
    a.ownerId === null ? [] : [a.ownerId],
  );
  const members =
    ownerIds.length === 0
      ? []
      : await system
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, projectId),
              inArray(projectMembers.userId, ownerIds),
            ),
          );
  const asked = await system
    .select({ userId: projectAccessRequests.userId })
    .from(projectAccessRequests)
    .where(
      and(
        eq(projectAccessRequests.projectId, projectId),
        inArray(
          projectAccessRequests.userId,
          agents.map((a) => a.id),
        ),
      ),
    );
  const memberIds = new Set(members.map((m) => m.userId));
  const askedIds = new Set(asked.map((r) => r.userId));
  return new Set(
    agents
      .filter(
        (a) =>
          askedIds.has(a.id) ||
          (a.ownerId !== null && memberIds.has(a.ownerId)),
      )
      .map((a) => a.id),
  );
}

export async function removeDenial(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  userId: number,
): Promise<void> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "access_denial.remove",
  );
  const deleted = await ctx.router
    .system()
    .delete(projectAccessDenials)
    .where(
      and(
        eq(projectAccessDenials.projectId, project.id),
        eq(projectAccessDenials.userId, userId),
      ),
    )
    .returning({ userId: projectAccessDenials.userId });
  if (deleted.length === 0) throw new NotFoundError("denial not found");
  ctx.bus.publish(project.id, {
    entity: "member",
    id: userId,
    action: "updated",
  });
}

/**
 * Whether the caller has been denied access to whatever `target` names, plus
 * who the caller is — everything the CLI needs to decide between printing an
 * access link and printing nothing (T-280).
 *
 * The resolution runs against the whole deployment, not against what the
 * caller may read — the same choice T-288's endpoint made, and for the same
 * reason: the case this exists to answer is precisely a project the caller
 * cannot read. What goes back is one boolean, so the resolution itself is
 * never disclosed: a target naming no project, one the caller cannot read,
 * and one it can all come back identical.
 */
export async function accessHint(
  ctx: AppContext,
  user: UserRow,
  target: string,
): Promise<AccessHint> {
  const self = { login: user.login, user_id: user.id };
  const project = await projectNamedBy(ctx, target);
  if (project === null) return { suppressed: false, ...self };
  const system = ctx.router.system();
  // The CLI asks only on its way to printing an access link, so this is the
  // agent's own "I asked", and what lets the people it asks deny it (T-657).
  // The answer below does not depend on it, so the caller learns nothing.
  if (user.kind === "machine") {
    await system
      .insert(projectAccessRequests)
      .values({ projectId: project, userId: user.id })
      .onConflictDoNothing();
  }
  const rows = await system
    .select({ userId: projectAccessDenials.userId })
    .from(projectAccessDenials)
    .where(
      and(
        eq(projectAccessDenials.projectId, project),
        eq(projectAccessDenials.userId, user.id),
      ),
    );
  return { suppressed: rows.length > 0, ...self };
}

/**
 * The id of the project `target` names, by any spelling the CLI may have been
 * handed: `PREFIX-N`, `slug/N`, a bare slug (current or retired), or a bare
 * id. Null when nothing claims it.
 */
async function projectNamedBy(
  ctx: AppContext,
  target: string,
): Promise<number | null> {
  const locator = parseRefLocator(target);
  const ref =
    locator === null
      ? target
      : locator.kind === "qualified"
        ? locator.slug
        : await holderOfPrefix(ctx, locator.prefix);
  if (ref === null) return null;
  return (await findProjectByRef(ctx, ref))?.project.id ?? null;
}

async function holderOfPrefix(
  ctx: AppContext,
  prefix: string,
): Promise<string | null> {
  const directory = await globalPrefixDirectory(ctx);
  return resolveClaim(directory.entries, directory.contested, prefix);
}
