import type {
  TokenCreated,
  TokenCreateInput,
  TokenListItem,
} from "@todou/shared";
import { and, eq, isNull } from "drizzle-orm";
import { generatePat } from "../auth/pat.ts";
import type { Db } from "../db/driver.ts";
import { tokens } from "../db/system-schema.ts";
import { NotFoundError } from "../errors.ts";

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

export async function listTokens(
  db: Db,
  userId: number,
): Promise<TokenListItem[]> {
  const rows = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.userId, userId), isNull(tokens.revokedAt)));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
  }));
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
