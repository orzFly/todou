import { type MemberRole, ROLE_RANK } from "@todou/shared";

/**
 * The most of `want` a ceiling allows, or null when it allows nothing at all
 * (T-340). A machine's role is capped at its owner's, and both places that
 * add one — the project settings page and the agent's own projects dialog —
 * have to apply the same cap, or the one that does not sends the ordinary
 * path into a 409.
 *
 * `undefined` is a ceiling nobody stated: a server from before the field.
 * It reads as null rather than as "no limit", because the client parses no
 * schema at runtime and a missing field would otherwise arrive as an
 * unbounded one.
 */
export function cappedRole(
  want: MemberRole,
  ceiling: MemberRole | null | undefined,
): MemberRole | null {
  if (ceiling == null) return null;
  return ROLE_RANK[want] <= ROLE_RANK[ceiling] ? want : ceiling;
}
