import type { IssueMove } from "./schemas/issue.ts";

/**
 * The move that ended the ownership interval `at` falls in, or null when that
 * interval is the current one.
 *
 * The one place the boundary rule lives, so anything that needs more of a
 * move than which project it came from — who performed it, what it
 * renumbered — reads the same interval `ownerAt` does. Generic in the move so
 * a caller's own row type comes straight back.
 */
export function moveAfter<M extends IssueMove>(
  moves: readonly M[],
  at: string,
): M | null {
  const ordered = [...moves].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  for (const move of ordered) {
    // A move's own events are written in the destination, so an exact tie
    // belongs to the new owner, not the old one.
    if (at < move.at) return move;
  }
  return null;
}

/**
 * Which project owned the card when `at` was written (T-231).
 *
 * A `#12` typed while the card lived in A means A/12 for as long as that text
 * says `#12`, so the reference grammar has to be applied under the project
 * that held the card at that instant, not under the one holding it now. The
 * `moves` array carries exactly the boundaries needed: each entry says "from
 * here on, no longer `from_project_id`".
 *
 * Null means the interval's owner is unknown — the reader may not read that
 * project — and callers render its local references as plain text rather
 * than guessing.
 */
export function ownerAt(
  moves: readonly IssueMove[],
  currentProjectId: number,
  at: string,
): number | null {
  const move = moveAfter(moves, at);
  return move === null ? currentProjectId : move.from_project_id;
}
