import { type QueryPart, splice } from "@orz/query";
import type { ProjectRefOption } from "@/lib/project-spellings.ts";

/** A project's spelling, offered to finish the word the caret is in. */
export type ProjectRefRow = {
  kind: "project-ref";
  slug: string;
  name: string;
  spelling: string;
  /** The whole query after taking it, and where the caret lands. */
  apply: { value: string; caret: number };
};

/**
 * The bare word the caret stands in, up to the caret, or an empty one where
 * it stands. Null where no project can go: inside a qualifier, which already
 * has a key, and inside quotes, which is how one asks for a literal.
 */
export function wordAt(
  parts: readonly QueryPart[],
  query: string,
  caret: number,
): { start: number; text: string } | null {
  for (const part of parts) {
    if (caret < part.start || caret > part.end) continue;
    if (part.kind === "filter") return null;
    if (part.kind === "text") {
      if (part.raw.startsWith('"')) return null;
      return { start: part.start, text: query.slice(part.start, caret) };
    }
  }
  return { start: caret, text: "" };
}

/**
 * Projects, offered against the bare word the caret is in and matched
 * case-insensitively — which is the point: `ac` has to reach `ACC-` and
 * `TOD` has to reach `todou/`, and reaching for shift first is exactly the
 * thing that does not happen mid-query.
 *
 * **One row per project.** The spellings are synonyms, so a second row for
 * the same project buys the reader nothing and costs a line of a panel whose
 * budget every source shares. The best one that matches wins; typing one
 * more character (`acce`, past the prefix) is how the other one is asked for.
 *
 * Nothing is completed to itself: once `ACC-` is typed, offering `ACC-` is
 * an offer to press Tab for no change.
 */
export function projectRefCompletions(
  pool: readonly ProjectRefOption[],
  parts: readonly QueryPart[],
  query: string,
  caret: number,
): { matched: boolean; rows: ProjectRefRow[] } {
  const word = wordAt(parts, query, caret);
  if (word === null || word.text === "") return { matched: false, rows: [] };
  const typed = word.text.toLowerCase();
  const rows: ProjectRefRow[] = [];
  for (const project of pool) {
    const spelling = project.spellings.find(
      (candidate) =>
        candidate.toLowerCase().startsWith(typed) &&
        candidate.toLowerCase() !== typed,
    );
    if (spelling === undefined) continue;
    rows.push({
      kind: "project-ref",
      slug: project.slug,
      name: project.name,
      spelling,
      // No trailing space: a prefix is completed to `ACC-` so that a number
      // can be typed straight onto it (T-268).
      apply: splice(query, word.start, word.start + word.text.length, spelling),
    });
  }
  return { matched: rows.length > 0, rows };
}
