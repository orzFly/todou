import type {
  CapabilityId,
  Member,
  MemberAddInput,
  MemberRole,
} from "@todou/shared";
import { ROLE_RANK } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { projectMembers, projects, users } from "../db/system-schema.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
import { type ProjectRow, projectRoleOf, requireCapability } from "./access.ts";
import { getUserRefs } from "./users.ts";

/**
 * Checked before `ensureAdminSurvives` so a sole admin hears the wall that
 * stays once the project gains a second admin. Instance admins are not exempt:
 * one exempt identity would leave no invariant at all.
 *
 * It reads the target only, never the collateral set, so removing a human does
 * take the caller's own machines with them (T-340) — a machine's membership
 * hangs off its owner's, and following it is not the self-service identity
 * edit this forbids.
 */
const SELF_MEMBERSHIP =
  "you cannot change your own membership — ask another admin";

const NO_ADMIN_LEFT = "this would leave the project with no admin at all";

/** One membership row to write. A null role means delete it. */
type Effect = { userId: number; role: MemberRole | null };

/** The target of a membership write, as far as picking the rules goes. */
type Target = { row: UserRow | null; capability: CapabilityId };

export async function listMembers(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Member[]> {
  const { project } = await requireCapability(ctx, actor, slug, "member.list");
  const system = ctx.router.system();
  const rows = await system
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, project.id));
  const refs = await getUserRefs(
    system,
    rows.map((r) => r.userId),
  );
  const ceilings = await ownerCeilings(
    system,
    project.id,
    rows
      .map((r) => refs.get(r.userId)?.owner?.id)
      .filter((id): id is number => id !== undefined),
  );
  return rows.map((row) => {
    // biome-ignore lint/style/noNonNullAssertion: getUserRefs covers all ids
    const user = refs.get(row.userId)!;
    return {
      user,
      role: row.role,
      created_at: row.createdAt.toISOString(),
      owner_role:
        user.owner === null ? null : (ceilings.get(user.owner.id) ?? null),
    };
  });
}

/**
 * The effective role each of these owners holds here, batched. Resolving the
 * ceiling per row would be an N+1 on a list that always renders in full.
 */
async function ownerCeilings(
  system: Db,
  projectId: number,
  ownerIds: number[],
): Promise<Map<number, MemberRole>> {
  const ceilings = new Map<number, MemberRole>();
  const unique = [...new Set(ownerIds)];
  if (unique.length === 0) return ceilings;
  for (const row of await system
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        inArray(projectMembers.userId, unique),
      ),
    )) {
    ceilings.set(row.userId, row.role);
  }
  // The same override `projectRoleOf` applies, and the reason the ceiling is
  // not simply the membership row: an instance admin is admin everywhere
  // while holding a row nowhere, so their machines would read as orphans.
  for (const row of await system
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.isInstanceAdmin, true)))) {
    ceilings.set(row.id, "admin");
  }
  return ceilings;
}

/** The membership rows of every machine this human owns in this project. */
async function ownedMachinesIn(
  system: Db,
  projectId: number,
  ownerUserId: number,
): Promise<{ userId: number; role: MemberRole }[]> {
  return system
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(users.kind, "machine"),
        eq(users.ownerId, ownerUserId),
      ),
    );
}

/**
 * Which gate this write answers to, decided by **who is being written**, not
 * by what the caller is (T-340): a machine that holds admin here edits
 * memberships exactly as a human admin does.
 *
 * A target that does not exist takes the admin gate. Falling back to the
 * reader one would turn a bad id into a membership-shaped probe any reader
 * could run.
 */
async function targetOf(
  system: Db,
  actor: UserRow,
  userId: number,
  own: CapabilityId,
  other: CapabilityId,
): Promise<Target> {
  const rows = await system.select().from(users).where(eq(users.id, userId));
  const row = rows[0] ?? null;
  const isOwnAgent =
    row !== null && row.kind === "machine" && row.ownerId === actor.id;
  return { row, capability: isOwnAgent ? own : other };
}

export async function setMember(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  userId: number,
  role: MemberRole,
): Promise<void> {
  const system = ctx.router.system();
  const target = await targetOf(
    system,
    actor,
    userId,
    "member.set_own_agent",
    "member.set",
  );
  // The project gate runs before anything is said about the target, so a
  // non-member never learns which user ids exist.
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    target.capability,
  );
  if (target.row === null) throw new NotFoundError("user not found");
  if (userId === actor.id) throw new ForbiddenError(SELF_MEMBERSHIP);

  await writeMembership(
    ctx,
    project,
    await plan(ctx, project, target.row, role),
  );
}

export async function removeMember(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  userId: number,
): Promise<void> {
  const system = ctx.router.system();
  const target = await targetOf(
    system,
    actor,
    userId,
    "member.remove_own_agent",
    "member.remove",
  );
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    target.capability,
  );
  if (target.row === null) throw new NotFoundError("user not found");
  if (userId === actor.id) throw new ForbiddenError(SELF_MEMBERSHIP);

  const held = await system
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, userId),
      ),
    );
  // Asked before anything is deleted, not read off the delete's own count: a
  // human with no row of their own may still own machines that have one, and
  // answering 404 after taking those out would be a refusal that wrote.
  if (held.length === 0) throw new NotFoundError("member not found");

  const effects: Effect[] = [{ userId, role: null }];
  if (target.row.kind === "human") {
    // A machine's membership is held up by its owner's: with the owner gone
    // there is no ceiling left to judge it against, so the rows go together
    // rather than leaving orphans nobody asked for.
    for (const machine of await ownedMachinesIn(system, project.id, userId)) {
      effects.push({ userId: machine.userId, role: null });
    }
  }
  await writeMembership(ctx, project, effects);
}

/**
 * Add by login (T-340). Separate from PUT because PUT needs a numeric id the
 * caller has no way to look up — there is no by-login lookup anywhere else in
 * the product, and this deliberately does not become one.
 */
export async function addMemberByLogin(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: MemberAddInput,
): Promise<Member> {
  // `member.set` first, before the login is so much as read: an admin-only
  // gate ahead of the lookup is the whole reason this endpoint may answer
  // "does this login exist" at all.
  const { project } = await requireCapability(ctx, actor, slug, "member.set");
  const system = ctx.router.system();
  const rows = await system
    .select()
    .from(users)
    .where(eq(users.login, input.login));
  const row = rows[0];
  // Flat, and never a near-miss suggestion: spelling hints would turn one
  // admin's guess into a directory read.
  if (!row) throw new NotFoundError("no such user");
  if (row.id === actor.id) throw new ForbiddenError(SELF_MEMBERSHIP);

  const existing = await system
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, row.id),
      ),
    );
  // Deliberately not PUT's upsert: the verb here is "add", and quietly
  // rewriting an existing role would let one slip demote somebody with
  // nothing on screen to say so. Changing a role is what PUT is for.
  if (existing.length > 0) throw new ConflictError("already a member");

  await writeMembership(
    ctx,
    project,
    await plan(ctx, project, row, input.role),
  );

  const [refs, written, ceilings] = await Promise.all([
    getUserRefs(system, [row.id]),
    system
      .select({ createdAt: projectMembers.createdAt })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          eq(projectMembers.userId, row.id),
        ),
      ),
    ownerCeilings(
      system,
      project.id,
      row.ownerId === null ? [] : [row.ownerId],
    ),
  ]);
  return {
    // biome-ignore lint/style/noNonNullAssertion: the row was just written
    user: refs.get(row.id)!,
    role: input.role,
    created_at: (written[0]?.createdAt ?? new Date()).toISOString(),
    owner_role:
      row.ownerId === null ? null : (ceilings.get(row.ownerId) ?? null),
  };
}

/**
 * The whole set of rows one requested role comes to: the target, plus
 * whatever the ceiling drags along with it. Throws rather than adjusting when
 * the request itself is out of bounds — a role quietly replaced by another is
 * the hardest kind of API behaviour to account for afterwards, and the web
 * page only ever offers legal ones, so the refusal is a guard rail for
 * concurrent edits and direct API calls rather than a normal path.
 */
async function plan(
  ctx: AppContext,
  project: ProjectRow,
  target: UserRow,
  role: MemberRole,
): Promise<Effect[]> {
  const system = ctx.router.system();
  const effects: Effect[] = [{ userId: target.id, role }];

  if (target.kind === "machine") {
    const owner =
      target.ownerId === null ? null : await userById(system, target.ownerId);
    const ceiling =
      owner === null ? null : await projectRoleOf(ctx, project, owner);
    if (ceiling === null) {
      throw new ConflictError(
        owner === null
          ? "this machine has no owner, so it has no ceiling here — it can only be removed"
          : `the owner of this machine, @${owner.login}, is not a member of this project — add them first`,
      );
    }
    if (ROLE_RANK[role] > ROLE_RANK[ceiling]) {
      throw new ConflictError(
        `@${owner?.login} is ${ceiling} in this project, and a machine cannot outrank its owner`,
      );
    }
    return effects;
  }

  const current = await system
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, target.id),
      ),
    );
  const before = current[0]?.role;
  // Only a demotion pulls machines down with it. A promotion deliberately
  // leaves them where they are: the invariant is a ceiling, and lifting it
  // grants nothing by itself — carrying them up would hand out authority
  // nobody asked for.
  if (before !== undefined && ROLE_RANK[role] < ROLE_RANK[before]) {
    for (const machine of await ownedMachinesIn(
      system,
      project.id,
      target.id,
    )) {
      if (ROLE_RANK[machine.role] > ROLE_RANK[role]) {
        effects.push({ userId: machine.userId, role });
      }
    }
  }
  return effects;
}

async function userById(system: Db, id: number): Promise<UserRow | null> {
  const rows = await system.select().from(users).where(eq(users.id, id));
  return rows[0] ?? null;
}

/**
 * Checked whole, then written whole: the check is worth nothing per row, and
 * worth nothing outside the transaction that acts on it either.
 *
 * The `for update` on the project row is what makes the count the check reads
 * still true when the writes land. Without it two requests each see the same
 * two admins, each conclude one of them may go, and between them they take
 * the last one — the exact failure this card exists to prevent, and not a
 * theoretical one where agents write memberships. Membership writes are the
 * only thing that takes this lock, and they are short.
 *
 * The effects were planned before the lock, because the ceiling comes from
 * `projectRoleOf`, which resolves its own connection and cannot join this
 * transaction. That costs nothing here: a stale effect list can only name a
 * row that no longer exists (the write becomes a no-op) or miss one that
 * appeared (it is left alone), and the admin count is re-read under the lock
 * either way, so the invariant does not rest on the planning being fresh.
 */
async function writeMembership(
  ctx: AppContext,
  project: ProjectRow,
  effects: Effect[],
): Promise<void> {
  const system = ctx.router.system();
  await system.transaction(async (tx) => {
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id))
      .for("update");
    await ensureAdminSurvives(tx, project.id, effects);
    for (const effect of effects) {
      if (effect.role === null) {
        await tx
          .delete(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, project.id),
              eq(projectMembers.userId, effect.userId),
            ),
          );
        continue;
      }
      await tx
        .insert(projectMembers)
        .values({
          projectId: project.id,
          userId: effect.userId,
          role: effect.role,
        })
        .onConflictDoUpdate({
          target: [projectMembers.projectId, projectMembers.userId],
          set: { role: effect.role },
        });
    }
  });
  // One event per affected row rather than one for the target: a client that
  // consumes them row by row would otherwise never hear about the collateral.
  for (const effect of effects) {
    ctx.bus.publish(project.id, {
      entity: "member",
      id: effect.userId,
      action: effect.role === null ? "deleted" : "updated",
    });
  }
}

/**
 * A project that has an explicit admin keeps one. Judged across the whole
 * effect set rather than the target row, which is what closes the hole the
 * collateral opened (T-340): where a human and their own machine are the only
 * two admins, removing the human passes a per-row check and then takes the
 * machine down with it, leaving nobody.
 *
 * Only membership rows count, as before. An instance admin holds none, so a
 * project whose only admin is one of them already has zero here — it stays
 * writable, because this refuses to go from some to none, not to be none.
 */
async function ensureAdminSurvives(
  system: Db,
  projectId: number,
  effects: Effect[],
): Promise<void> {
  const admins = new Set(
    (
      await system
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.role, "admin"),
          ),
        )
    ).map((row) => row.userId),
  );
  if (admins.size === 0) return;
  for (const effect of effects) {
    if (effect.role === "admin") admins.add(effect.userId);
    else admins.delete(effect.userId);
  }
  if (admins.size === 0) throw new ConflictError(NO_ADMIN_LEFT);
}
