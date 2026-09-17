import type { ReactNode } from "react";
import { MatchHighlight } from "@/components/shared/match-highlight.tsx";
import type { ProjectMatch } from "@/lib/project-match.ts";
import { cn } from "@/lib/utils";

export type ProjectRowProject = {
  name: string;
  slug: string;
  prefix: string | null;
};

/**
 * One project in a chooser: icon, name, and the spelling it is known by
 * elsewhere.
 *
 * The trailing token is always there, and one rule fills it — the REF where
 * there is one, the slug where there is not. Not two cases but one: the slot
 * means "how this project gets written down", and a project without a prefix
 * is written down by its slug (`homelab/12`). Leaving it empty instead would
 * put gaps in a column and read as missing rather than as absent.
 *
 * `match` says why the row survived the filter, and the paint follows it. A
 * slug that is already standing in the trailing token is marked there rather
 * than repeated as its own segment.
 */
export function ProjectRow({
  project,
  match,
  muted,
  icon,
  note,
  trailing,
}: {
  project: ProjectRowProject;
  /** Null under an empty query, where nothing was matched to explain. */
  match: ProjectMatch | null;
  muted?: boolean;
  icon?: ReactNode;
  /**
   * A word about the project itself — the Reference submenu's `(current)`.
   * Beside the name rather than at the end, because it says what this project
   * is to the reader; hanging it past the spelling token would take that
   * token out of the column it shares with every other row.
   */
  note?: ReactNode;
  /** The switcher's unread badge; the other hosts hang nothing here. */
  trailing?: ReactNode;
}) {
  const token = project.prefix ?? project.slug;
  const slugSegment = match?.field === "slug" && token !== project.slug;
  const markToken =
    match !== null &&
    (match.field === "prefix" || (match.field === "slug" && !slugSegment));

  return (
    <>
      {icon}
      <span className={cn("truncate", muted && "text-muted-foreground")}>
        {match?.field === "name" ? (
          <MatchHighlight text={project.name} range={match.range} />
        ) : (
          project.name
        )}
      </span>
      {note}
      {slugSegment && (
        <span className="shrink-0 text-muted-foreground text-xs">
          <MatchHighlight text={project.slug} range={match.range} />
        </span>
      )}
      <span
        data-slot="project-spelling"
        className="ml-auto shrink-0 text-muted-foreground text-xs"
      >
        {markToken ? (
          <MatchHighlight text={token} range={match.range} />
        ) : (
          token
        )}
      </span>
      {trailing}
    </>
  );
}
