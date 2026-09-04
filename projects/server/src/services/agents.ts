import type {
  Agent,
  AgentCreateInput,
  AgentMemberships,
  AgentUpdateInput,
  MemberRole,
  ProjectBrief,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
} from "@todou/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import {
  projectMembers,
  projects,
  tokens,
  users,
} from "../db/system-schema.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
import { deleteAvatar, setAvatar, updateProfile } from "./profile.ts";
import { issueToken, listTokens, revokeToken } from "./tokens.ts";
import { ownerRefOf, toMe } from "./users.ts";

async function toAgent(ctx: AppContext, row: UserRow): Promise<Agent> {
  return {
    ...toMe(row, await ownerRefOf(ctx.router.system(), row)),
    disabled_at: row.disabledAt?.toISOString() ?? null,
  };
}

export async function createAgent(
  ctx: AppContext,
  actor: UserRow,
  input: AgentCreateInput,
): Promise<Agent> {
  if (actor.kind === "machine") {
    throw new ForbiddenError("machine users cannot create agents");
  }
  const system = ctx.router.system();
  const clash = await system
    .select({ id: users.id })
    .from(users)
    .where(eq(users.login, input.login));
  if (clash.length > 0) {
    throw new ConflictError(`login "${input.login}" is already taken`);
  }
  const inserted = await system
    .insert(users)
    .values({
      kind: "machine",
      login: input.login,
      displayName: input.display_name,
      ownerId: actor.id,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("agent insert returned no row");
  return toAgent(ctx, row);
}

export async function listAgents(
  ctx: AppContext,
  actor: UserRow,
  owner: "me" | "all",
): Promise<Agent[]> {
  if (owner === "all" && !actor.isInstanceAdmin) {
    throw new ForbiddenError("owner=all requires instance admin");
  }
  const system = ctx.router.system();
  const rows = await system
    .select()
    .from(users)
    .where(
      owner === "all"
        ? eq(users.kind, "machine")
        : and(eq(users.kind, "machine"), eq(users.ownerId, actor.id)),
    );
  const result: Agent[] = [];
  for (const row of rows) {
    result.push(await toAgent(ctx, row));
  }
  return result;
}

/** Owner or instance admin; anything else is a hard 403. */
async function loadManagedAgent(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
): Promise<UserRow> {
  const rows = await ctx.router
    .system()
    .select()
    .from(users)
    .where(and(eq(users.id, agentId), eq(users.kind, "machine")));
  const row = rows[0];
  if (!row) throw new NotFoundError("agent not found");
  if (row.ownerId !== actor.id && !actor.isInstanceAdmin) {
    throw new ForbiddenError("only the owner or an instance admin");
  }
  return row;
}

export async function updateAgent(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
  input: AgentUpdateInput,
): Promise<Agent> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  const row = await updateProfile(ctx, agent, input);
  return toAgent(ctx, row);
}

export async function setAgentAvatar(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
  file: File,
): Promise<Agent> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  return toAgent(ctx, await setAvatar(ctx, agent, file));
}

export async function deleteAgentAvatar(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
): Promise<Agent> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  return toAgent(ctx, await deleteAvatar(ctx, agent));
}

/** Soft-disable: blocks all authentication and revokes every active PAT. */
export async function disableAgent(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
): Promise<void> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  const system = ctx.router.system();
  const now = new Date();
  await system
    .update(users)
    .set({ disabledAt: now })
    .where(eq(users.id, agent.id));
  await system
    .update(tokens)
    .set({ revokedAt: now })
    .where(and(eq(tokens.userId, agent.id), isNull(tokens.revokedAt)));
}

/**
 * Undo a disable. Tokens revoked by the disable stay revoked — the agent
 * needs a freshly issued PAT to act again.
 */
export async function enableAgent(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
): Promise<Agent> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  const updated = await ctx.router
    .system()
    .update(users)
    .set({ disabledAt: null })
    .where(eq(users.id, agent.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("agent enable returned no row");
  return toAgent(ctx, row);
}

/**
 * The one rule set every route that hands an agent a token must apply:
 * only the owner or an instance admin, and never a disabled agent. Shared
 * with the CLI device-authorization flow (T-140), which mints for an agent
 * without going through this file's token endpoint.
 */
export async function loadAgentForToken(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
): Promise<UserRow> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  if (agent.disabledAt) {
    throw new ConflictError("agent is disabled");
  }
  return agent;
}

export async function issueAgentToken(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
  input: TokenCreateInput,
): Promise<TokenCreated> {
  const agent = await loadAgentForToken(ctx, actor, agentId);
  return issueToken(ctx.router.system(), agent.id, input);
}

export async function listAgentTokens(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
): Promise<TokenListItem[]> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  return listTokens(ctx.router.system(), agent.id);
}

export async function revokeAgentToken(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
  tokenId: number,
): Promise<void> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  await revokeToken(ctx.router.system(), agent.id, tokenId);
}

/**
 * Display order, not a permission order — access.ts keeps its own RANK
 * ascending by privilege for comparisons, and does not export it.
 */
const ROLE_ORDER: Record<MemberRole, number> = {
  admin: 0,
  writer: 1,
  reader: 2,
};

const toBrief = (p: typeof projects.$inferSelect): ProjectBrief => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
});

/**
 * Every membership of every agent I own, listed whole — including projects I
 * cannot read myself. That leaks nothing: as owner I may issue the agent a
 * PAT at will and enumerate its projects as the agent, so hiding them would
 * only make "how many projects is this agent in" answer wrongly here. Writes
 * get no such reprieve; they stay behind each project's own admin check.
 *
 * Sorted server-side because the column truncates to a few badges: the cut
 * has to be deterministic, with the most privileged rows above it.
 */
export async function listAgentMemberships(
  ctx: AppContext,
  actor: UserRow,
): Promise<AgentMemberships> {
  const system = ctx.router.system();

  const mine = await system
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.kind, "machine"), eq(users.ownerId, actor.id)));
  const agentIds = mine.map((r) => r.id);

  const rows =
    agentIds.length === 0
      ? []
      : await system
          .select({
            agentId: projectMembers.userId,
            role: projectMembers.role,
            createdAt: projectMembers.createdAt,
            project: projects,
          })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .where(inArray(projectMembers.userId, agentIds));

  // An instance admin is admin in every project without holding a membership
  // row anywhere (projectRoleOf's rule), so the candidate set is the table.
  const manageable = actor.isInstanceAdmin
    ? await system.select().from(projects)
    : (
        await system
          .select({ project: projects })
          .from(projectMembers)
          .innerJoin(projects, eq(projects.id, projectMembers.projectId))
          .where(
            and(
              eq(projectMembers.userId, actor.id),
              eq(projectMembers.role, "admin"),
            ),
          )
      ).map((r) => r.project);

  return {
    memberships: rows
      .map((r) => ({
        agent_id: r.agentId,
        project: toBrief(r.project),
        role: r.role,
        created_at: r.createdAt.toISOString(),
      }))
      .sort(
        (a, b) =>
          a.agent_id - b.agent_id ||
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          a.project.slug.localeCompare(b.project.slug),
      ),
    manageable_projects: manageable
      .map(toBrief)
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}
