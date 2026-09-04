import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

export const UserKind = z.enum(["human", "machine"]);
export type UserKind = z.infer<typeof UserKind>;

// "me" is the CLI's self-reference in --assignee; "ghost" stands in for
// deleted accounts in historical data. Neither may become a real login.
export const RESERVED_LOGINS = new Set(["me", "ghost"]);

export const Login = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits, and dashes")
  .refine((v) => !RESERVED_LOGINS.has(v), "this login is reserved");

/** Compact user reference embedded in issues, comments, events, chips. */
export const UserRef = z.object({
  id: Id,
  login: z.string(),
  display_name: z.string(),
  kind: UserKind,
  avatar_url: z
    .string()
    .nullable()
    .describe("Versioned avatar URL; null = render the initials fallback"),
  owner: z
    .object({ id: Id, login: z.string() })
    .nullable()
    .describe("Owning human for machine users"),
});
export type UserRef = z.infer<typeof UserRef>;

export const User = UserRef.extend({
  email: z.email().nullable(),
  is_instance_admin: z.boolean(),
  created_at: Timestamp,
});
export type User = z.infer<typeof User>;

export const Me = User;
export type Me = z.infer<typeof Me>;

/**
 * Self-service profile edit. Machine users may rename their display name
 * but not their login — that stays with the owner (see AgentUpdateInput).
 */
export const MeUpdateInput = z.object({
  display_name: z.string().trim().min(1).max(200).optional(),
  login: Login.optional(),
});
export type MeUpdateInput = z.infer<typeof MeUpdateInput>;

/**
 * Avatars are small by design — independent of the attachment upload limit.
 * Shared rather than server-local because the browser scales oversized images
 * down against this same number before uploading; two copies would drift.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const AVATAR_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const AVATAR_CONTENT_TYPE_SET: ReadonlySet<string> = new Set(
  AVATAR_CONTENT_TYPES,
);

export function isAvatarContentType(type: string): boolean {
  return AVATAR_CONTENT_TYPE_SET.has(type);
}
