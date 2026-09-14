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
type Effect = {
  userId: number;
  role: MemberRole | null;
  kind: "human" | "machine";
  /**
   * The row the request actually named, which is created when it is missing.
   * Everything else here is collateral — dragged in because the owner's role
   * moved — and those rows are only ever updated in place. Upserting them
   * would resurrect a membership somebody removed while this write was
   * waiting: `onConflictDoUpdate` on a missing row inserts rather than doing
   * nothing.
   *
   * Also the only row that drags others along, which is what stops a
   * collateral clamp from recursing into a second round of collateral.
   */
  target?: true;
  /** Only for machines: whose ceiling this row answers to. */
  ownerId?: number | null;
};

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
 * What these users hold here, batched: their membership role where they have
 * one, and separately whether they are an instance admin. Resolving it per row
 * would be an N+1 on a list that always renders in full.
 *
 * The two are kept apart rather than folded into one role because a caller
 * re-checking a ceiling mid-write has to know which of the two it is: a
 * membership role can be overridden by a role this same write is about to
 * hand out, and an instance admin's implicit admin cannot.
 */
async function rolesHere(
  db: Db,
  projectId: number,
  userIds: number[],
): Promise<{ member: Map<number, MemberRole>; instanceAdmin: Set<number> }> {
  const member = new Map<number, MemberRole>();
  const instanceAdmin = new Set<number>();
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return { member, instanceAdmin };
  for (const row of await db
    .select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        inArray(projectMembers.userId, unique),
      ),
    )) {
    member.set(row.userId, row.role);
  }
  for (const row of await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, unique), eq(users.isInstanceAdmin, true)))) {
    instanceAdmin.add(row.id);
  }
  return { member, instanceAdmin };
}

/**
 * The effective role each of these owners holds here — the ceiling on any
 * machine of theirs. The instance-admin override is the reason this is not
 * simply the membership row: an instance admin is admin everywhere while
 * holding a row nowhere, so their machines would otherwise read as orphans.
 */
async function ownerCeilings(
  db: Db,
  projectId: number,
  ownerIds: number[],
): Promise<Map<number, MemberRole>> {
  const { member, instanceAdmin } = await rolesHere(db, projectId, ownerIds);
  for (const id of instanceAdmin) member.set(id, "admin");
  return member;
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

  // A machine's membership is held up by its owner's: with the owner gone
  // there is no ceiling left to judge it against, so the rows go together
  // rather than leaving orphans nobody asked for. Which machines those are is
  // settled under the lock — see `expandCollateral`.
  await writeMembership(ctx, project, [
    { userId, role: null, kind: target.row.kind, target: true },
  ]);
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
 * The row the request named, and a refusal when the request itself is out of
 * bounds. Refuses rather than adjusting — a role quietly replaced by another
 * is the hardest kind of API behaviour to account for afterwards, and the web
 * page only ever offers legal ones, so this is a guard rail for concurrent
 * edits and direct API calls rather than a normal path.
 *
 * Only the named row: what a role change drags along with it is worked out
 * under the lock, by `expandCollateral`, because a set enumerated out here
 * is a set that can go stale before it is written.
 *
 * This ceiling check is therefore not where the invariant lands — that is
 * `ensureCeilingsHold`. It is here to produce the error a caller can act on,
 * naming the owner and the exact ceiling, which the under-lock pass has no
 * cheap way to phrase.
 */
async function plan(
  ctx: AppContext,
  project: ProjectRow,
  target: UserRow,
  role: MemberRole,
): Promise<Effect[]> {
  const system = ctx.router.system();
  if (target.kind !== "machine") {
    return [{ userId: target.id, role, kind: "human", target: true }];
  }

  const owner =
    target.ownerId === null ? null : await userById(system, target.ownerId);
  if (owner === null) {
    throw new ConflictError(
      "this machine has no owner, so it has no ceiling here — it can only be removed",
    );
  }
  const ceiling = await projectRoleOf(ctx, project, owner);
  if (ceiling === null) {
    throw new ConflictError(
      `the owner of this machine, @${owner.login}, is not a member of this project — add them first`,
    );
  }
  if (ROLE_RANK[role] > ROLE_RANK[ceiling]) {
    throw new ConflictError(
      `@${owner.login} is ${ceiling} in this project, and a machine cannot outrank its owner`,
    );
  }
  return [
    {
      userId: target.id,
      role,
      kind: "machine",
      ownerId: target.ownerId,
      target: true,
    },
  ];
}

/**
 * What the named row drags along with it, read under the lock rather than
 * carried in from planning.
 *
 * Enumerating it earlier leaves a hole that has nothing to do with the rows
 * it names and everything to do with the ones it does not: a machine already
 * below the owner's new role is not collateral, so it is absent from the set
 * — and a concurrent write can raise it above that role while this one waits
 * for the lock. `ensureCeilingsHold` only judges rows the set contains, so
 * the machine ends up outranking its owner with nothing left to correct it.
 * Re-reading here is the same move as re-reading the ceiling, applied to the
 * other half of the question.
 *
 * It also picks up a machine that joined while this write waited, which an
 * owner's removal then takes with it as it should.
 */
async function expandCollateral(
  tx: Db,
  projectId: number,
  effects: Effect[],
): Promise<Effect[]> {
  const settled = [...effects];
  const present = new Set(effects.map((e) => e.userId));

  for (const effect of effects) {
    if (effect.kind !== "human" || effect.target !== true) continue;
    const machines = await ownedMachinesIn(tx, projectId, effect.userId);

    if (effect.role === null) {
      for (const machine of machines) {
        if (present.has(machine.userId)) continue;
        settled.push({
          userId: machine.userId,
          role: null,
          kind: "machine",
          ownerId: effect.userId,
        });
        present.add(machine.userId);
      }
      continue;
    }

    const held = await tx
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, effect.userId),
        ),
      );
    const before = held[0]?.role;
    // Only a demotion pulls machines down, judged against the role the owner
    // holds right now rather than the one planning saw. A promotion leaves
    // them where they are: the invariant is a ceiling, and lifting it grants
    // nothing by itself — carrying them up would hand out authority nobody
    // asked for.
    if (before === undefined || ROLE_RANK[effect.role] >= ROLE_RANK[before]) {
      continue;
    }
    for (const machine of machines) {
      if (present.has(machine.userId)) continue;
      if (ROLE_RANK[machine.role] <= ROLE_RANK[effect.role]) continue;
      settled.push({
        userId: machine.userId,
        role: effect.role,
        kind: "machine",
        ownerId: effect.userId,
      });
      present.add(machine.userId);
    }
  }
  return settled;
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
 * Everything the outcome depends on is settled here, under the lock: which
 * rows come along with the named one, whether any machine would end up above
 * its owner, and whether an admin is left. What arrives from outside is only
 * the row the caller asked for.
 *
 * That split is the point. Each of those three read before the lock leaves a
 * different hole, and the one that is easiest to miss is the set itself — a
 * machine that was legal when the set was built is simply absent from it, so
 * a later check has nothing to judge.
 *
 * Deadlock-free by shape rather than by counting: this transaction takes
 * exactly one explicit lock, always the same row, always first, and afterwards
 * writes only `projectMembers` — which nothing else writes while holding a
 * lock. An argument from "no other lock site touches these tables" would not
 * survive the next one being added.
 */
async function writeMembership(
  ctx: AppContext,
  project: ProjectRow,
  effects: Effect[],
): Promise<void> {
  const system = ctx.router.system();
  let settled = effects;
  await system.transaction(async (tx) => {
    await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, project.id))
      .for("update");
    settled = await expandCollateral(tx, project.id, effects);
    await ensureAdminSurvives(tx, project.id, settled);
    await ensureCeilingsHold(tx, project.id, settled);
    for (const effect of settled) {
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
      if (effect.target !== true) {
        // Collateral is updated, never upserted. Even read under the lock the
        // row can be gone by now — the reads above and these writes are one
        // transaction, but the row was deleted before it began — and creating
        // it again would undo somebody's removal in the name of a clamp.
        await tx
          .update(projectMembers)
          .set({ role: effect.role })
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
  for (const effect of settled) {
    ctx.bus.publish(project.id, {
      entity: "member",
      id: effect.userId,
      action: effect.role === null ? "deleted" : "updated",
    });
  }
}

/**
 * No machine outranks its owner, judged on the rows this transaction holds
 * rather than on the ones planning happened to read. The ceiling is looked up
 * before the lock, so between the two a concurrent write can demote or remove
 * the owner; without this the machine keeps the role the stale ceiling
 * allowed, and nothing later goes back to correct it — the invariant would be
 * broken silently and permanently, which is worse than the refusal.
 *
 * The owner's role after this batch, not before it: demoting a human and
 * clamping their machines is one effect set, and reading the owner's stored
 * row here would judge the machines against the role the owner is leaving.
 */
async function ensureCeilingsHold(
  tx: Db,
  projectId: number,
  effects: Effect[],
): Promise<void> {
  const machines = effects.filter(
    (e): e is Effect & { role: MemberRole } =>
      e.role !== null && e.ownerId !== undefined,
  );
  if (machines.length === 0) return;

  const written = new Map<number, MemberRole>();
  const removed = new Set<number>();
  for (const effect of effects) {
    if (effect.role === null) removed.add(effect.userId);
    else written.set(effect.userId, effect.role);
  }
  const ownerIds = machines
    .map((e) => e.ownerId)
    .filter((id): id is number => id != null);
  const { member, instanceAdmin } = await rolesHere(tx, projectId, ownerIds);

  for (const effect of machines) {
    const ownerId = effect.ownerId;
    const ceiling =
      ownerId == null
        ? null
        : // An instance admin's admin is not a membership row, so nothing in
          // this batch can take it away.
          instanceAdmin.has(ownerId)
          ? "admin"
          : removed.has(ownerId)
            ? null
            : (written.get(ownerId) ?? member.get(ownerId) ?? null);
    if (ceiling === null) {
      throw new ConflictError(
        "the owner of this machine is not a member of this project — add them first",
      );
    }
    if (ROLE_RANK[effect.role] > ROLE_RANK[ceiling]) {
      throw new ConflictError(
        `the owner is ${ceiling} in this project, and a machine cannot outrank its owner`,
      );
    }
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
