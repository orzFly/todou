import { Link } from "@tanstack/react-router";
import { isHidden, type TimelineComment } from "@todou/shared";
import { createContext, type ReactNode, useContext } from "react";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

/**
 * How many hover cards deep this subtree already is. The preview renders the
 * comment through the same MarkdownView, so its own comment links would
 * become triggers and nest without end.
 */
const HoverDepth = createContext(0);

/** Long enough that a pointer crossing a link on its way elsewhere is quiet. */
const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 150;

export function CommentHoverCard({
  slug,
  issueNumber,
  comment,
  children,
}: {
  slug: string;
  issueNumber: number;
  comment: TimelineComment;
  /** The link the reader hovers. */
  children: ReactNode;
}) {
  return (
    <HoverCard openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent>
        <HoverDepth.Provider value={1}>
          <div className="mb-2 flex items-center gap-2">
            <UserChip user={comment.author} />
            <Link
              to="/projects/$slug/issues/$number"
              params={{ slug, number: String(issueNumber) }}
              hash={commentAnchor(comment.id)}
              hashScrollIntoView={false}
              className="shrink-0 text-xs whitespace-nowrap text-muted-foreground hover:underline"
              title={comment.created_at}
            >
              {new Date(comment.created_at).toLocaleString()}
            </Link>
          </div>
          {isHidden(comment) ? (
            <p className="text-sm text-muted-foreground">
              This comment is hidden.
            </p>
          ) : (
            // No `issueNumber`: rich attachment references would fetch the
            // issue's attachment list, and a preview that costs a request is
            // one a reader can set off by sweeping the pointer across a
            // paragraph. Images keep rendering — a download URL serves the
            // bytes either way.
            <div className="max-h-64 overflow-y-auto overscroll-contain">
              <MarkdownView slug={slug}>{comment.body}</MarkdownView>
            </div>
          )}
        </HoverDepth.Provider>
      </HoverCardContent>
    </HoverCard>
  );
}

/** False inside a hover card's own preview, where a second one may not open. */
export function useCanHoverComment(): boolean {
  return useContext(HoverDepth) === 0;
}
