import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

export const TokenCreateInput = z.object({
  name: z.string().min(1).max(100),
  expires_at: Timestamp.nullish(),
});
export type TokenCreateInput = z.infer<typeof TokenCreateInput>;

/** Returned exactly once at issuance — the only time the plaintext exists. */
export const TokenCreated = z.object({
  id: Id,
  token: z.string(),
  prefix: z.string(),
  name: z.string(),
  expires_at: Timestamp.nullable(),
});
export type TokenCreated = z.infer<typeof TokenCreated>;

export const TokenListItem = z.object({
  id: Id,
  name: z.string(),
  prefix: z.string(),
  created_at: Timestamp,
  expires_at: Timestamp.nullable(),
  revoked_at: Timestamp.nullable(),
  last_used_at: Timestamp.nullable(),
  holder: UserRef,
});
export type TokenListItem = z.infer<typeof TokenListItem>;

/**
 * Whose tokens `GET /me/tokens` lists: the caller's own, those of the agents
 * the caller owns, or both. Ownership is the only widening — an instance
 * admin's `agents` is still just the agents they own.
 */
export const TokenListQuery = z.object({
  holder: z.enum(["me", "agents", "all"]).default("me"),
});
export type TokenListQuery = z.infer<typeof TokenListQuery>;
