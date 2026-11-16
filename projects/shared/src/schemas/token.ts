import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

/**
 * Sent with a human's Bearer token to make the request as one of their agents
 * (T-693). The value is the agent's login.
 */
export const ACT_AS_HEADER = "x-todou-act-as";

/**
 * What a token may do beyond acting as its holder, chosen at issuance and
 * fixed for its lifetime. An empty set is a plain token. `agents:act` lets it
 * carry {@link ACT_AS_HEADER}; `agents:create` also creates the named agent
 * when the login is unused, and is only valid beside `agents:act`. Listed in
 * the order responses use.
 */
export const TOKEN_SCOPES = ["agents:act", "agents:create"] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

export const TokenCreateInput = z.object({
  name: z.string().min(1).max(100),
  expires_at: Timestamp.nullish(),
  // Optional rather than defaulted: this is also the callers' argument type,
  // and a default would make every caller spell out an empty list.
  scopes: z.array(TokenScope).optional(),
});
export type TokenCreateInput = z.infer<typeof TokenCreateInput>;

/** Returned exactly once at issuance — the only time the plaintext exists. */
export const TokenCreated = z.object({
  id: Id,
  token: z.string(),
  prefix: z.string(),
  name: z.string(),
  expires_at: Timestamp.nullable(),
  scopes: z.array(TokenScope),
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
  scopes: z.array(TokenScope),
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
