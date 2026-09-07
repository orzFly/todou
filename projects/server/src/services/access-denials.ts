import {
  type AccessDenial,
  type AccessHint,
  parseRefLocator,
  resolveClaim,
} from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { projectAccessDenials, users } from "../db/system-schema.ts";
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
  const rows = await system
    .select()
    .from(projectAccessDenials)
    .where(eq(projectAccessDenials.projectId, project.id));
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

  const target = await system
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId));
  const row = target[0];
  if (row === undefined) throw new NotFoundError("user not found");
  // Agents only. A human asking for access says so in words and is answered
  // in words; this record exists to silence a hint printed by a program, and
  // there is no such hint for a person to silence.
  if (row.kind !== "machine") {
    throw new ValidationFailedError("only agents can be denied access");
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
  const rows = await ctx.router
    .system()
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
  return resolveClaim(
    directory.entries,
    directory.contested,
    prefix,
    new Date().toISOString(),
  );
}
