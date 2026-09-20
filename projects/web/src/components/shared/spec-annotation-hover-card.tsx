import {
  formatAnchorRange,
  isHidden,
  type SpecCommentItem,
} from "@todou/shared";
import { FileTextIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  COMMENT_HEADER_ROW,
  CommentHeaderIdentity,
  CommentHeaderLine,
  CommentHeaderMeta,
} from "@/components/shared/comment-header-meta.tsx";
import {
  CLOSE_DELAY_MS,
  HoverDepth,
  OPEN_DELAY_MS,
  useCanHoverPreview,
} from "@/components/shared/hover-preview.ts";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.tsx";
import { cn } from "@/lib/utils";

/**
 * A spec annotation, previewed off the row that names it (T-406). What a
 * reader wants here is not a comment body on its own but the anchored source
 * beside what the reviewer said about it, so this is its own card rather
 * than CommentHoverCard fed different data.
 *
 * The depth guard lives here because the row that mounts this is built by a
 * plain function, which cannot ask.
 */
export function SpecAnnotationHoverCard({
  slug,
  issueNumber,
  annotation,
  children,
}: {
  slug: string;
  issueNumber: number;
  annotation: SpecCommentItem;
  /** The link the reader hovers. */
  children: ReactNode;
}) {
  const canHover = useCanHoverPreview();
  if (!canHover) return <>{children}</>;

  const anchor = annotation.anchor;
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
            <CommentHeaderLine>
              <CommentHeaderIdentity>
                <UserChip user={annotation.author} />
              </CommentHeaderIdentity>
              <CommentHeaderMeta
                className="ml-auto"
                slug={slug}
                issueNumber={issueNumber}
                commentId={annotation.comment_id}
                createdAt={annotation.created_at}
              />
            </CommentHeaderLine>
          </div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <FileTextIcon className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{anchor.path}</span>
            <span className="shrink-0">
              {formatAnchorRange(anchor)} · v{anchor.version}
            </span>
          </div>
          {anchor.quote !== "" && (
            <pre className="mb-2 max-h-32 overflow-auto rounded-md border bg-background px-2 py-1 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {anchor.quote}
            </pre>
          )}
          {isHidden(annotation) ? (
            <p className="text-sm text-muted-foreground">
              This comment is hidden.
            </p>
          ) : (
            // No `issueNumber`, as CommentHoverCard does: rich attachment
            // references would fetch the issue's attachment list, and a
            // preview a pointer sets off in passing must spend no request.
            <div className="max-h-64 overflow-y-auto overscroll-contain">
              <MarkdownView slug={slug}>{annotation.body}</MarkdownView>
            </div>
          )}
        </HoverDepth.Provider>
      </HoverCardContent>
    </HoverCard>
  );
}
