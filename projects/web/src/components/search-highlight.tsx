import type { SearchSnippet } from "@todou/shared";
import { Fragment } from "react";

/**
 * How a hit is painted, wherever it was found. Shared with the local matching
 * in `shared/match-highlight.tsx` so the two cannot drift apart; the two keep
 * separate components because only one of them can claim the server found it.
 */
export const MARK_CLASS =
  "rounded-sm bg-yellow-200/70 text-foreground dark:bg-yellow-500/30";

type Part = { at: number; text: string; hit: boolean };

/** The snippet cut into painted and unpainted runs, in order. Exported for tests. */
export function splitSnippet(snippet: SearchSnippet): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const [start, end] of snippet.ranges) {
    // Two terms can hit the same run; the second one starts behind the
    // cursor and its text has already been emitted.
    if (start < at) continue;
    if (start > at) {
      parts.push({ at, text: snippet.text.slice(at, start), hit: false });
    }
    parts.push({ at: start, text: snippet.text.slice(start, end), hit: true });
    at = end;
  }
  if (at < snippet.text.length) {
    parts.push({ at, text: snippet.text.slice(at), hit: false });
  }
  return parts;
}

/**
 * A snippet with the server's hit ranges marked. The ranges are UTF-16
 * offsets into `snippet.text`, so this is a slice — the client never re-runs
 * the matching and cannot disagree with what the server actually found.
 */
export function SearchHighlight({ snippet }: { snippet: SearchSnippet }) {
  return (
    <>
      {splitSnippet(snippet).map((part) => (
        // Keyed by where the run starts: parts are positions in one string,
        // and no two of them can begin at the same offset.
        <Fragment key={part.at}>
          {part.hit ? (
            <mark className={MARK_CLASS}>{part.text}</mark>
          ) : (
            part.text
          )}
        </Fragment>
      ))}
    </>
  );
}
