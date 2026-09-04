import type { MemberRole } from "@todou/shared";
import { and, isNull, type SQL } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { issues } from "../db/project-schema.ts";
import {
  IssueDeletedError,
  IssueMovedError,
  IssueMovingError,
  NotFoundError,
} from "../errors.ts";

/**
 * Cards that still exist here (T-145, T-231). Every query that walks issues
 * carries it unless it is explicitly the trash view, and it has to be a SQL
 * predicate rather than a filter over the results — the list, the counts and
 * the activity stream all paginate, so dropping rows afterwards would
 * corrupt both the page sizes and the cursors (same reasoning as
 * `crossRefVisibleCondition`).
 */
export const live: SQL = and(
  isNull(issues.deletedAt),
  isNull(issues.movedAt),
) as SQL;

/**
 * Cards that may become the target of a NEW reference — `live`, minus the
 * ones mid-move.
 *
 * Narrower than `live` because reference recording does not go through the
 * write gate: it is a side effect of writing some *other* issue and filters
 * targets by predicate alone, so the freeze in the cross-database protocol
 * cannot stop it. An event landing on a card while it is being copied is an
 * event the source-side cleanup then deletes. Refusing it up front is the
 * same call the trash already makes.
 */
export const referenceable: SQL = and(live, isNull(issues.movingSince)) as SQL;

/**
 * The gate's column set, spread into every partial select that will be
 * gated. Named once so widening it stays a change to this file rather than
 * a hunt through a dozen hand-written select lists.
 */
export const gateColumns = {
  id: issues.id,
  projectId: issues.projectId,
  number: issues.number,
  deletedAt: issues.deletedAt,
  movedAt: issues.movedAt,
  movingSince: issues.movingSince,
  authorId: issues.authorId,
};

/** The columns the gates below read; every loadIssue helper selects them. */
export type TrashFields = {
  id: number;
  projectId: number;
  number: number;
  deletedAt: Date | null;
  movedAt: Date | null;
  movingSince: Date | null;
  authorId: number;
};

/**
 * Who may see a card once it is in the trash: project admins across the
 * whole project, and the card's author for their own. Deliberately the same
 * rule as delete/restore permission — anyone who could put it back must be
 * able to find it, including when someone else did the deleting.
 */
export function seesTrashed(
  row: Pick<TrashFields, "authorId">,
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
 *
 * A tombstone is checked first and answered by the error handler, which
 * turns the marker into a redirect. The order is free of ambiguity rather
 * than merely convenient: a card cannot be in the trash and moved at once,
 * because moving one out of the trash is refused.
 */
export function assertIssueReadable(
  row: TrashFields,
  actor: UserRow,
  /**
   * Null only from the entries that consult the address book (T-242), which
   * reach this gate before knowing whether the reader belongs here.
   */
  role: MemberRole | null,
): void {
  if (row.movedAt !== null)
    throw new IssueMovedError(row, false, role !== null);
  // The tombstone above is the only thing a reader without a role can be
  // answered with; a card still living here is not theirs to see.
  if (role === null) throw new NotFoundError("issue not found");
  if (row.deletedAt === null) return;
  if (!seesTrashed(row, actor, role))
    throw new NotFoundError("issue not found");
}

/**
 * Write gate: the same visibility, but seeing a trashed card earns a 409
 * instead of permission — a card in the trash is frozen until it is
 * restored, and so is one being copied to another project.
 */
export function assertIssueWritable(
  row: TrashFields,
  actor: UserRow,
  role: MemberRole,
): void {
  // Always readable at the source: writing still demands a writer role there.
  if (row.movedAt !== null) throw new IssueMovedError(row, true, true);
  if (row.movingSince !== null) throw new IssueMovingError();
  if (row.deletedAt === null) return;
  if (seesTrashed(row, actor, role)) throw new IssueDeletedError();
  throw new NotFoundError("issue not found");
}
