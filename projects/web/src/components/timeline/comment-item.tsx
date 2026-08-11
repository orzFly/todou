import type { TimelineComment } from "@todou/shared";
import { api } from "@/api/queries.ts";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";

export function CommentItem({
  slug,
  issueNumber,
  comment,
  pending = false,
}: {
  slug: string;
  issueNumber: number;
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
        <AgentContextBadge context={comment.agent_context} />
        <span
          className="text-xs text-muted-foreground"
          title={comment.created_at}
        >
          {new Date(comment.created_at).toLocaleString()}
        </span>
        {comment.edited_at && (
          <RevisionHistory
            label="comment"
            editedAt={comment.edited_at}
            filename="comment.md"
            queryKey={["revisions", slug, issueNumber, "comment", comment.id]}
            fetchRevisions={() =>
              api.getCommentRevisions(slug, issueNumber, comment.id)
            }
          />
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
