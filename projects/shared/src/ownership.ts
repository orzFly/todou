import type { IssueMove } from "./schemas/issue.ts";

/**
 * Which project owned the card when `at` was written (T-231).
 *
 * Text is never rewritten, so a `#12` typed while the card lived in A means
 * A/12 forever — the reference grammar has to be applied under the project
 * that held the card at that instant, not under the one holding it now.
 * The `moves` array carries exactly the boundaries needed: each entry says
 * "from here on, no longer `from_project_id`".
 *
 * Null means the interval's owner is unknown — the reader may not read that
 * project — and callers render its local references as plain text rather
 * than guessing.
 */
export function ownerAt(
  moves: IssueMove[],
  currentProjectId: number,
  at: string,
): number | null {
  const ordered = [...moves].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );
  for (const move of ordered) {
    // A move's own events are written in the destination, so an exact tie
    // belongs to the new owner, not the old one.
    if (at < move.at) return move.from_project_id;
  }
  return currentProjectId;
}
