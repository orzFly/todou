import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BlockRef } from "@todou/shared";
import type { ReactNode } from "react";
import { issueQuery } from "@/api/issues.ts";
import {
  CLOSE_DELAY_MS,
  HoverDepth,
  OPEN_DELAY_MS,
  useCanHoverPreview,
} from "@/components/shared/hover-preview.ts";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";

/** The badge and this list receive the same unresolved edges (T-423). */
export function BlockedHoverCard({
  slug,
  refs,
  children,
}: {
  slug: string;
  refs: BlockRef[];
  children: ReactNode;
}) {
  const canHover = useCanHoverPreview();
  if (!canHover) return <>{children}</>;

  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        // Board cards are draggable. Portal events still bubble through the
        // React tree; selecting a preview's text must not drag its owner.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <HoverDepth.Provider value={1}>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Blocked by
          </p>
          {/* Mount links only on open: their existing batcher/cache supplies
              titles without a request behind every badge on the page. */}
          <ul className="max-h-64 space-y-1 overflow-y-auto overscroll-contain text-sm wrap-anywhere">
            {refs.map((ref) => (
              <li key={ref.edge_id}>
                {ref.hidden || ref.project === null || ref.number === null ? (
                  <span className="text-muted-foreground italic">
                    a card you cannot see
                  </span>
                ) : ref.blocker_deleted ? (
                  <TrashedBlocker
                    slug={ref.project}
                    number={ref.number}
                    spelled={`${ref.project === slug ? "" : `${ref.project}/`}${ref.ref ?? `#${ref.number}`}`}
                  />
                ) : (
                  <IssueLink
                    slug={ref.project}
                    number={ref.number}
                    pageSlug={slug}
                  />
                )}
                {ref.blocker_deleted && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    (in the trash)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </HoverDepth.Provider>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The normal reference batch excludes trash. The detail endpoint applies
 * trash read permissions, and shares its cache with the issue page.
 */
function TrashedBlocker({
  slug,
  number,
  spelled,
}: {
  slug: string;
  number: number;
  spelled: string;
}) {
  const issue = useQuery({ ...issueQuery(slug, number), staleTime: 60_000 });
  const returnState = useReturnLinkState();
  if (!issue.data) return <span>{spelled}</span>;
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(number) }}
      state={returnState}
      className="font-medium hover:underline"
    >
      <span className="font-normal text-muted-foreground">{spelled} </span>
      {issue.data.title}
    </Link>
  );
}
