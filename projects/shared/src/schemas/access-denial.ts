import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

/**
 * One agent told, by somebody who can see this project, to stop asking for
 * access to it (T-280). Not a permission: it only suppresses the hint and
 * link the CLI prints, and a project admin may still add that agent by hand.
 *
 * Keyed by project rather than by the string the agent typed, so every
 * spelling of the same project — its slug, a retired slug, `PREFIX-N` — is
 * covered by one record.
 */
export const AccessDenial = z.object({
  user: UserRef,
  denied_by: UserRef,
  created_at: Timestamp,
});
export type AccessDenial = z.infer<typeof AccessDenial>;

/**
 * The answer to "should I print an access link for this target, and whose
 * name goes in it" — the whole of what `GET /me/access-hint` will say.
 *
 * It deliberately says nothing about the target: whether it resolves to a
 * project, and whether the caller may read that project, are both absent, so
 * the response is identical for a project that does not exist, one the caller
 * cannot read, and one it can. `suppressed` is about the caller's own record
 * and nothing else.
 */
export const AccessHint = z.object({
  suppressed: z.boolean(),
  login: z.string(),
  user_id: Id,
});
export type AccessHint = z.infer<typeof AccessHint>;
