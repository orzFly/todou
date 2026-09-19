import { enumLookup, type MemberRole, roleRankOf } from "@todou/shared";

/**
 * The dot colour each role is drawn with. Visual grouping only — every badge
 * carrying one writes the role out in text beside it, so the colour is never
 * the only thing saying which role this is.
 *
 * Here rather than in either of the two files that draw one (the agents
 * table's project badges, the user page's seats), because four colours kept
 * in two places are four colours that drift.
 */
export const ROLE_DOT: Record<MemberRole, string> = {
  admin: "bg-violet-500",
  writer: "bg-sky-500",
  reporter: "bg-teal-500",
  reader: "bg-muted-foreground",
};

const UNKNOWN_ROLE_DOT = "bg-muted-foreground";

export function roleDotOf(role: string): string {
  return enumLookup(ROLE_DOT, role, () => UNKNOWN_ROLE_DOT, "role");
}

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
 * Future desired roles and ceilings cannot produce a known grant either.
 * Validate the required desired role even when the ceiling is absent.
 */
export function cappedRole(
  want: MemberRole,
  ceiling: MemberRole | null | undefined,
): MemberRole | null {
  const wantRank = roleRankOf(want);
  const ceilingRank = ceiling == null ? undefined : roleRankOf(ceiling);
  if (wantRank === undefined || ceilingRank === undefined || ceiling == null) {
    return null;
  }
  return wantRank <= ceilingRank ? want : ceiling;
}
