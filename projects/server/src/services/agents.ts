import type {
  Agent,
  AgentCreateInput,
  AgentUpdateInput,
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
} from "@todou/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import type { AppContext } from "../bootstrap.ts";
import { tokens, users } from "../db/system-schema.ts";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.ts";
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
  const updated = await ctx.router
    .system()
    .update(users)
    .set({
      ...(input.display_name === undefined
        ? {}
        : { displayName: input.display_name }),
    })
    .where(eq(users.id, agent.id))
    .returning();
  const row = updated[0];
  if (!row) throw new Error("agent update returned no row");
  return toAgent(ctx, row);
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

export async function issueAgentToken(
  ctx: AppContext,
  actor: UserRow,
  agentId: number,
  input: TokenCreateInput,
): Promise<TokenCreated> {
  const agent = await loadManagedAgent(ctx, actor, agentId);
  if (agent.disabledAt) {
    throw new ConflictError("agent is disabled");
  }
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
