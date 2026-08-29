import type { MemberRole } from "@todou/shared";
import { isNull, type SQL } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { issues } from "../db/project-schema.ts";
import { IssueDeletedError, NotFoundError } from "../errors.ts";

/**
 * The trash predicate (T-145). Every query that walks issues carries it
 * unless it is explicitly the trash view, and it has to be a SQL predicate
 * rather than a filter over the results — the list, the counts and the
 * activity stream all paginate, so dropping rows afterwards would corrupt
 * both the page sizes and the cursors (same reasoning as
 * `crossRefVisibleCondition`).
 */
export const notDeleted: SQL = isNull(issues.deletedAt);

/** The columns the gates below read; every loadIssue helper selects them. */
export type TrashFields = { deletedAt: Date | null; authorId: number };

/**
 * Who may see a card once it is in the trash: project admins across the
 * whole project, and the card's author for their own. Deliberately the same
 * rule as delete/restore permission — anyone who could put it back must be
 * able to find it, including when someone else did the deleting.
 */
export function seesTrashed(
  row: TrashFields,
  actor: UserRow,
  role: MemberRole,
): boolean {
  return role === "admin" || row.authorId === actor.id;
}

/**
 * Read gate: a trashed card stays readable to whoever may see the trash and
 * simply does not exist for everyone else. The 404 is the point — a reader
 * who may not see the trash must not be able to tell a deleted card apart
 * from a number nobody ever used.
 */
export function assertIssueReadable(
  row: TrashFields,
  actor: UserRow,
  role: MemberRole,
): void {
  if (row.deletedAt === null) return;
  if (!seesTrashed(row, actor, role))
    throw new NotFoundError("issue not found");
}

/**
 * Write gate: the same visibility, but seeing a trashed card earns a 409
 * instead of permission — a card in the trash is frozen until it is
 * restored.
 */
export function assertIssueWritable(
  row: TrashFields,
  actor: UserRow,
  role: MemberRole,
): void {
  if (row.deletedAt === null) return;
  if (seesTrashed(row, actor, role)) throw new IssueDeletedError();
  throw new NotFoundError("issue not found");
}
