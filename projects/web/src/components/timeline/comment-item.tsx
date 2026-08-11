import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TimelineComment } from "@todou/shared";
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type Viewer = { id: number; isAdmin: boolean };

/** Mirror of the server rule: the author or a project admin may edit. */
export function canEditComment(
  viewer: Viewer | null | undefined,
  authorId: number,
): boolean {
  if (!viewer) return false;
  return viewer.isAdmin || viewer.id === authorId;
}

export function CommentItem({
  slug,
  issueNumber,
  comment,
  viewer = null,
  pending = false,
}: {
  slug: string;
  issueNumber: number;
  comment: TimelineComment;
  viewer?: Viewer | null;
  pending?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.updateComment(slug, issueNumber, comment.id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["timeline", slug, issueNumber],
      });
      setEditing(false);
    },
    onError: (error) => toast.error(error.message),
  });

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
        {!pending && canEditComment(viewer, comment.author.id) && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-auto"
            aria-label="edit comment"
            onClick={() => {
              setBody(comment.body);
              setEditing(!editing);
            }}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="px-3 py-2">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => save.mutate()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <MarkdownView>{comment.body}</MarkdownView>
        )}
      </div>
    </div>
  );
}
