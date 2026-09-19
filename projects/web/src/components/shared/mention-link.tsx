import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { membersQuery } from "@/api/queries.ts";
import { MENTION_CHIP_STRUCTURE } from "@/components/shared/rich-chip.ts";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * A stored @mention, rendered as a chip: the member's CURRENT login and
 * avatar, linked to their page at its current address. The link in the text
 * is anchored on the permanent user id; what the reader sees is id →
 * today's login, the same id-first contract an issue reference renders
 * under (T-373).
 *
 * Unknown id or login — someone who left the project, or an account deleted
 * — falls back to the author's own spelling, not a link: the degradation an
 * unreadable reference takes, for the same reason. The address is already
 * in the text; rendering it would promise a page this project can no longer
 * vouch for.
 */
export function MentionLink({
  slug,
  userId,
  login,
  fallback,
}: {
  /** The project the text was written in — whose member list answers. */
  slug: string;
  userId?: number;
  login?: string;
  /** The author's typed spelling, for the fallback. */
  fallback: string;
}) {
  const members = useQuery(membersQuery(slug));
  const list = members.data ?? [];
  const member =
    userId !== undefined
      ? list.find((m) => m.user.id === userId)
      : list.find((m) => m.user.login === login);
  if (member === undefined) return <>{fallback}</>;
  const user = member.user;
  return (
    <Link
      to="/users/$ref"
      params={{ ref: user.login }}
      data-mention-link={user.id}
      className={cn("font-medium hover:underline", MENTION_CHIP_STRUCTURE)}
      title={displayNameOf(user)}
    >
      {/* The avatar's fallback is the reader's initials as real text, and the
          badge is a second box beside it — both are picture, not identity. */}
      <span data-mention-decoration>
        <UserAvatar user={user} badge className="mr-0.5 inline-flex" />
      </span>
      <span data-mention-token>{`@${user.login}`}</span>
    </Link>
  );
}
