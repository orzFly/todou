/**
 * The lines a failed command adds when the failure is "you have no access to
 * that project" (T-280): a link a person who can see the project opens, to
 * grant this account a role there, or to say no.
 *
 * Link construction happens here and nowhere else, so the invariant the
 * design rests on has exactly one object to be tested against:
 *
 * > the bytes the CLI writes to stderr because it cannot read a project are a
 * > function of the user's input, this machine's configuration, and this
 * > caller's own denial record — of nothing the server said about the target.
 *
 * Hence the conditional wording on the unreadable path: the target may be a
 * typo, and the alternative — probing whether it exists before deciding what
 * to print — is the leak this rules out. "Try" carries that.
 */

export type GrantAccessKind =
  /** 404: no such project, or none this account may read. */
  | "unreadable"
  /** 403: the project reads fine, the role is too low. */
  | "role";

/** Who the link preselects. `user_id` is the only part the page trusts. */
export type GrantAccessWho = { login: string; user_id: number };

export function grantAccessUrl(
  webOrigin: string,
  target: string,
  who: GrantAccessWho,
): string {
  const url = new URL(`${webOrigin}/grant-access`);
  url.searchParams.set("target", target);
  // `login` is a display hint the page never writes; `uid` is what a Deny
  // records. Both are visible and both are the opener's to overrule — see
  // design.md §4.
  url.searchParams.set("login", who.login);
  url.searchParams.set("uid", String(who.user_id));
  return url.toString();
}

export function grantAccessLines(
  webOrigin: string,
  target: string,
  who: GrantAccessWho,
  kind: GrantAccessKind,
): string[] {
  const link = `  ${grantAccessUrl(webOrigin, target, who)}`;
  if (kind === "role") {
    return [`ask an admin to raise ${who.login}'s role in "${target}":`, link];
  }
  return [
    `"${target}" may not exist, or may not be readable by ${who.login}`,
    "if such a project does exist, you can try asking an admin for access:",
    link,
  ];
}
