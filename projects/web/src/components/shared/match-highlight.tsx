import { MARK_CLASS } from "@/components/search-highlight.tsx";
import type { ProjectMatch } from "@/lib/project-match.ts";

/**
 * One locally-matched span of `text` marked.
 *
 * Deliberately not `SearchHighlight`, whose ranges come from the server and
 * therefore cannot disagree with what was really found. These come from
 * `matchProject` running in the browser, so the same `<mark>` would otherwise
 * carry two different claims about who found it. Only the colour is shared.
 */
export function MatchHighlight({
  text,
  range,
}: {
  text: string;
  range: ProjectMatch["range"];
}) {
  if (range === null || range.start >= range.end) return <>{text}</>;
  return (
    <>
      {text.slice(0, range.start)}
      <mark className={MARK_CLASS}>{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </>
  );
}
