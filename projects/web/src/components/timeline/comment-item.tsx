import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TimelineComment } from "@todou/shared";
import { PencilIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import { withAttachmentMarkers } from "@/components/timeline/composer.tsx";
import { QuestionsCard } from "@/components/timeline/questions-card.tsx";
import { SpecCommentAnchorCard } from "@/components/timeline/spec-comment-card.tsx";
import { Button } from "@/components/ui/button";
import { useRefCompletion } from "@/lib/editor/ref-completion.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

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
  const editor = useRef<MarkdownEditorHandle>(null);
  const [uploading, setUploading] = useState(false);
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const refCompletion = useRefCompletion(slug);
  const save = useMutation({
    mutationFn: (finalBody: string) =>
      api.updateComment(slug, issueNumber, comment.id, finalBody),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["timeline", slug, issueNumber],
      });
      setEditing(false);
      staging.clear();
    },
    onError: (error) => toast.error(error.message),
  });

  async function handleSave() {
    if (uploading) return;
    const body = editor.current?.getValue() ?? comment.body;
    let full = body;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(slug, issueNumber);
        full = withAttachmentMarkers(body.trimEnd(), markers);
      } catch (error) {
        toast.error(`Could not upload files: ${(error as Error).message}`);
        return;
      } finally {
        setUploading(false);
      }
    }
    save.mutate(full);
  }

  return (
    <div
      // Anchor target for #comment-<id> permalinks; pending comments have
      // no server id yet, so they never claim an anchor.
      id={pending ? undefined : commentAnchor(comment.id)}
      className={`rounded-lg border ${pending ? "opacity-60" : ""}`}
      data-comment-id={comment.id}
    >
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <UserChip user={comment.author} />
        <AgentContextBadge context={comment.agent_context} />
        {pending ? (
          <span
            className="shrink-0 text-xs whitespace-nowrap text-muted-foreground"
            title={comment.created_at}
          >
            {new Date(comment.created_at).toLocaleString()}
          </span>
        ) : (
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
        )}
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
              // The editor mounts fresh off comment.body each time edit mode
              // opens, so an abandoned draft never survives into the next one.
              staging.clear();
              setEditing(!editing);
            }}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="px-3 py-2">
        {/* Spec anchors render ABOVE the body: they are the context the
            comment is about (GitHub review-comment layout, T-23). */}
        {!pending && comment.component?.type === "spec_comment" && (
          <SpecCommentAnchorCard
            slug={slug}
            issueNumber={issueNumber}
            commentId={comment.id}
            component={comment.component}
            resolvedAt={comment.resolved_at}
            canResolve={viewer !== null}
          />
        )}
        {editing ? (
          <div className="space-y-2">
            <MarkdownEditor
              ref={editor}
              autoFocus
              initialValue={comment.body}
              ariaLabel="Edit comment"
              className="min-h-28"
              placeholder="Edit comment… (paste or drop files)"
              extensions={refCompletion}
              onPaste={staging.onPaste}
              onDrop={staging.onDrop}
              onDragOver={staging.onDragOver}
              onSubmit={() => void handleSave()}
              onCancel={() => {
                staging.clear();
                setEditing(false);
              }}
            />
            <StagedFileTray
              staged={staging.staged}
              onRemove={staging.remove}
              disabled={uploading}
            />
            <div className="flex justify-end gap-2">
              <StagedFileUploadButton
                onFiles={staging.stage}
                disabled={uploading}
                label="Attach files"
                className="mr-auto"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  staging.clear();
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={uploading}
                onClick={() => void handleSave()}
              >
                {uploading ? "Uploading…" : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <MarkdownView
            slug={slug}
            issueNumber={issueNumber}
            refDate={comment.created_at}
          >
            {comment.body}
          </MarkdownView>
        )}
        {/* The component slot renders after the body and is immutable, so
            it stays put while the body above is edited. */}
        {!pending && !editing && comment.component?.type === "questions" && (
          <QuestionsCard
            slug={slug}
            issueNumber={issueNumber}
            commentId={comment.id}
            component={comment.component}
            refDate={comment.created_at}
          />
        )}
      </div>
    </div>
  );
}
