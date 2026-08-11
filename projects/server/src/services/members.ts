import type { Member, MemberRole } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { projectMembers, users } from "../db/system-schema.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { requireProject } from "./access.ts";
import { getUserRefs } from "./users.ts";

export async function listMembers(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
): Promise<Member[]> {
  const { project } = await requireProject(ctx, actor, slug, "reader");
  const system = ctx.router.system();
  const rows = await system
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, project.id));
  const refs = await getUserRefs(
    system,
    rows.map((r) => r.userId),
  );
  return rows.map((row) => ({
    // biome-ignore lint/style/noNonNullAssertion: getUserRefs covers all ids
    user: refs.get(row.userId)!,
    role: row.role,
    created_at: row.createdAt.toISOString(),
  }));
}

export async function setMember(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  userId: number,
  role: MemberRole,
): Promise<void> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  const system = ctx.router.system();

  const target = await system
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId));
  if (target.length === 0) throw new NotFoundError("user not found");

  if (role !== "admin") {
    await ensureNotLastAdmin(ctx, project.id, userId);
  }
  await system
    .insert(projectMembers)
    .values({ projectId: project.id, userId, role })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role },
    });
  ctx.bus.publish(project.id, {
    entity: "member",
    id: userId,
    action: "updated",
  });
}

export async function removeMember(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  userId: number,
): Promise<void> {
  const { project } = await requireProject(ctx, actor, slug, "admin");
  await ensureNotLastAdmin(ctx, project.id, userId);
  const deleted = await ctx.router
    .system()
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, userId),
      ),
    )
    .returning({ userId: projectMembers.userId });
  if (deleted.length === 0) throw new NotFoundError("member not found");
  ctx.bus.publish(project.id, {
    entity: "member",
    id: userId,
    action: "deleted",
  });
}

/** A project must always keep at least one explicit admin member. */
async function ensureNotLastAdmin(
  ctx: AppContext,
  projectId: number,
  affectedUserId: number,
): Promise<void> {
  const admins = await ctx.router
    .system()
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, "admin"),
      ),
    );
  if (admins.length === 1 && admins[0]?.userId === affectedUserId) {
    throw new ConflictError("cannot demote or remove the last admin");
  }
}
