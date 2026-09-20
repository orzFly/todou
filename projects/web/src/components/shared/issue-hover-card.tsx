import { useQuery } from "@tanstack/react-query";
import type { IssueListItem } from "@todou/shared";
import type { ReactNode } from "react";
import { issueQuery } from "@/api/issues.ts";
import { LabelChips } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  CLOSE_DELAY_MS,
  HoverDepth,
  OPEN_DELAY_MS,
} from "@/components/shared/hover-preview.ts";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { displayNameOf, UserChip } from "@/components/shared/user-chip.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

/**
 * What a card is, for a reader who has not opened it: everything
 * `issueRefQuery` already holds, plus the body.
 *
 * Only the body costs anything. The metadata arrived with the reference that
 * drew the link — `IssueListItem` is the whole card minus its body — so the
 * card is complete the moment it opens and only the body block waits.
 */
export function IssueHoverCard({
  slug,
  number,
  spelled,
  item,
  children,
}: {
  /** Where the card is now, which is where its body is read from. */
  slug: string;
  number: number;
  /** The ref as the link spells it, qualified across projects. */
  spelled: string;
  /**
   * Undefined while the batched lookup is still out. There is then no card to
   * draw, so none is mounted — but the trigger is, which is what keeps the
   * anchor a stable DOM node (see IssueLink). A pointer resting through the
   * wait gets the card when it lands.
   */
  item: IssueListItem | undefined;
  /** The link the reader hovers. */
  children: ReactNode;
}) {
  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {item !== undefined && (
        <HoverCardContent>
          <HoverDepth.Provider value={1}>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <StatusPill status={item.status} />
              <span className="shrink-0">{spelled}</span>
              <span className="truncate" title={item.created_at}>
                opened by {displayNameOf(item.author)} ·{" "}
                {new Date(item.created_at).toLocaleDateString()}
              </span>
            </div>
            {/* In full: the link's own title may have been cut to the chip's
              width cap, or dropped as a repeat. */}
            <p className="mb-2 text-sm font-medium">{item.title}</p>
            {item.labels.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <LabelChips labels={item.labels} />
              </div>
            )}
            {item.assignees.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {item.assignees.map((user) => (
                  <UserChip key={user.id} user={user} />
                ))}
              </div>
            )}
            <IssueBody slug={slug} number={number} />
          </HoverDepth.Provider>
        </HoverCardContent>
      )}
    </HoverCard>
  );
}

/**
 * Its own component so that the query mounts with the card rather than with
 * the link. `HoverCardContent` renders nothing until the card opens (no
 * `forceMount`), so a hook called out here would put this request behind
 * every reference on the page instead of behind the few a reader stops on.
 */
function IssueBody({ slug, number }: { slug: string; number: number }) {
  // Share the detail cache so saved bodies reach previews and hovering warms
  // the detail page. This observer's freshness window avoids repeat reads
  // on quick rehovers without changing the detail page's own freshness.
  const issue = useQuery({ ...issueQuery(slug, number), staleTime: 60_000 });
  if (issue.isPending) {
    return (
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    );
  }
  // A body that would not load leaves the block empty: the metadata above is
  // already worth the card, and an error is not worth reading past in a
  // surface the reader opened by holding still.
  if (issue.data === undefined) return null;
  if (issue.data.body.trim() === "") {
    return (
      <p className="text-sm text-muted-foreground italic">No description.</p>
    );
  }
  return (
    // No `issueNumber`: rich attachment references would fetch the issue's
    // attachment list, a second request behind the one the reader asked for.
    // Images keep rendering — a download URL serves the bytes either way.
    <div className="max-h-56 overflow-y-auto overscroll-contain">
      <MarkdownView slug={slug}>{issue.data.body}</MarkdownView>
    </div>
  );
}
