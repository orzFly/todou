import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { Login } from "./user.ts";

/**
 * Crockford base32 minus the ambiguous letters, so a code read off one
 * screen and typed on another cannot be misread. Stored and compared
 * without dashes and uppercased; only the display form carries a dash.
 */
export const CliAuthCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
export type CliAuthCode = z.infer<typeof CliAuthCode>;

/** Whatever the user pasted or typed, back to the stored form. */
export function normalizeCliAuthCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** Display form: the terminal, the URL, and the page all show `XXXX-XXXX`. */
export function formatCliAuthCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const CliAuthRequestCreateInput = z.object({
  name: z.string().min(1).max(100),
});
export type CliAuthRequestCreateInput = z.infer<
  typeof CliAuthRequestCreateInput
>;

/** `poll_secret` is returned exactly once — only its hash is stored. */
export const CliAuthRequestCreated = z.object({
  id: Id,
  code: CliAuthCode,
  poll_secret: z.string(),
  interval: z.number().int().positive(),
  expires_in: z.number().int().positive(),
});
export type CliAuthRequestCreated = z.infer<typeof CliAuthRequestCreated>;

export const CliAuthPollInput = z.object({
  poll_secret: z.string().min(1),
});
export type CliAuthPollInput = z.infer<typeof CliAuthPollInput>;

/** The token exists only in the `approved` reply; it is never stored. */
export const CliAuthPollResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("approved"), token: z.string() }),
]);
export type CliAuthPollResult = z.infer<typeof CliAuthPollResult>;

/** What the authorization page shows so the user can check it against their terminal. */
export const CliAuthRequestInfo = z.object({
  id: Id,
  name: z.string(),
  code: CliAuthCode,
  created_at: Timestamp,
  expires_at: Timestamp,
});
export type CliAuthRequestInfo = z.infer<typeof CliAuthRequestInfo>;

/** Who the token will belong to; mirrors the loopback page's AuthTarget. */
export const CliAuthTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("me") }),
  z.object({ kind: z.literal("agent"), id: Id }),
  z.object({ kind: z.literal("new"), login: Login }),
]);
export type CliAuthTarget = z.infer<typeof CliAuthTarget>;

export const CliAuthApproveInput = z.object({ target: CliAuthTarget });
export type CliAuthApproveInput = z.infer<typeof CliAuthApproveInput>;

/** null when authorizing yourself; otherwise the agent to preselect next time. */
export const CliAuthApproveResult = z.object({ agent_id: Id.nullable() });
export type CliAuthApproveResult = z.infer<typeof CliAuthApproveResult>;
