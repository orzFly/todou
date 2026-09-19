import { isHidden, type TimelineComment } from "@todou/shared";
import type { ReactNode } from "react";
import {
  COMMENT_HEADER_ROW,
  CommentHeaderIdentity,
  CommentHeaderMeta,
} from "@/components/shared/comment-header-meta.tsx";
import {
  CLOSE_DELAY_MS,
  HoverDepth,
  OPEN_DELAY_MS,
} from "@/components/shared/hover-preview.ts";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";
import { cn } from "@/lib/utils";

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
          <div
            className={cn(
              "mb-2 flex flex-wrap items-baseline gap-2",
              COMMENT_HEADER_ROW,
            )}
          >
            <CommentHeaderIdentity>
              <UserChip user={comment.author} />
            </CommentHeaderIdentity>
            <CommentHeaderMeta
              className="ml-auto"
              slug={slug}
              issueNumber={issueNumber}
              commentId={comment.id}
              createdAt={comment.created_at}
            />
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
