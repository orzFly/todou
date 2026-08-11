import type { TimelineComment } from "@todou/shared";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";

export function CommentItem({
  comment,
  pending = false,
}: {
  comment: TimelineComment;
  pending?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border ${pending ? "opacity-60" : ""}`}
      data-comment-id={comment.id}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <UserChip user={comment.author} />
        <span
          className="text-xs text-muted-foreground"
          title={comment.created_at}
        >
          {new Date(comment.created_at).toLocaleString()}
        </span>
        {comment.edited_at && (
          <span className="text-xs text-muted-foreground/70">(edited)</span>
        )}
        {pending && (
          <span className="ml-auto text-xs text-muted-foreground">
            sending…
          </span>
        )}
      </div>
      <div className="px-3 py-2">
        <MarkdownView>{comment.body}</MarkdownView>
      </div>
    </div>
  );
}
