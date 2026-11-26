import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@orz/ui/components/hover-card";
import type { BlockRef } from "@todou/shared";
import type { ReactNode } from "react";
import {
  CLOSE_DELAY_MS,
  HoverDepth,
  OPEN_DELAY_MS,
  useCanHoverPreview,
} from "@/components/shared/hover-preview.ts";
import { IssueLink } from "@/components/shared/issue-link.tsx";
import { TrashedBlocker } from "@/components/shared/trashed-blocker.tsx";

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
              // Hang wrapped titles past the status glyph, as the sidebar does.
              <li key={ref.edge_id} className="pl-4 -indent-4">
                {ref.hidden || ref.project === null || ref.number === null ? (
                  <span className="text-muted-foreground italic">
                    a card you cannot see
                  </span>
                ) : ref.blocker_deleted ? (
                  <TrashedBlocker
                    slug={ref.project}
                    number={ref.number}
                    spelling={ref.ref}
                    pageSlug={slug}
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
