import type {
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
  TokenListQuery,
} from "@todou/shared";
import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import { generatePat } from "../auth/pat.ts";
import type { Db } from "../db/driver.ts";
import { tokens, users } from "../db/system-schema.ts";
import { NotFoundError } from "../errors.ts";
import { getUserRefs } from "./users.ts";

export async function issueToken(
  db: Db,
  userId: number,
  input: TokenCreateInput,
): Promise<TokenCreated> {
  const { token, hash, prefix } = generatePat();
  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  const inserted = await db
    .insert(tokens)
    .values({ userId, name: input.name, tokenHash: hash, prefix, expiresAt })
    .returning({ id: tokens.id });
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error("token insert returned no id");
  return {
    id,
    token,
    prefix,
    name: input.name,
    expires_at: expiresAt?.toISOString() ?? null,
  };
}

/**
 * Active tokens whose holder matches `holderFilter`, oldest first, each with
 * its holder attached. The filter is the whole authorization: callers decide
 * whose tokens may be listed and express it as a predicate on `users`.
 */
async function listTokensWhere(
  db: Db,
  holderFilter: SQL | undefined,
): Promise<TokenListItem[]> {
  const rows = await db
    .select({ token: tokens })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .where(and(holderFilter, isNull(tokens.revokedAt)))
    .orderBy(asc(tokens.id));
  const holders = await getUserRefs(
    db,
    rows.map((r) => r.token.userId),
  );
  return rows.map(({ token: row }) => {
    const holder = holders.get(row.userId);
    if (!holder) throw new Error(`token ${row.id} has no holder ref`);
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      created_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? null,
      revoked_at: row.revokedAt?.toISOString() ?? null,
      last_used_at: row.lastUsedAt?.toISOString() ?? null,
      holder,
    };
  });
}

export function listTokens(db: Db, userId: number): Promise<TokenListItem[]> {
  return listTokensWhere(db, eq(users.id, userId));
}

/**
 * `GET /me/tokens?holder=…`. "agents" means machine users whose owner is
 * the caller — deliberately not widened for instance admins, so this page
 * never shows a token its viewer could not already list one agent at a time.
 */
export function listHeldTokens(
  db: Db,
  actorId: number,
  holder: TokenListQuery["holder"],
): Promise<TokenListItem[]> {
  const mine = eq(users.id, actorId);
  const myAgents = and(eq(users.kind, "machine"), eq(users.ownerId, actorId));
  return listTokensWhere(
    db,
    holder === "me"
      ? mine
      : holder === "agents"
        ? myAgents
        : or(mine, myAgents),
  );
}

export async function revokeToken(
  db: Db,
  userId: number,
  tokenId: number,
): Promise<void> {
  const updated = await db
    .update(tokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(tokens.id, tokenId),
        eq(tokens.userId, userId),
        isNull(tokens.revokedAt),
      ),
    )
    .returning({ id: tokens.id });
  if (updated.length === 0) throw new NotFoundError("token not found");
}
