import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MemberRole, TimelineComment } from "@todou/shared";
import { can, isHidden } from "@todou/shared";
import { EyeOffIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { invalidateSearchRefQueries } from "@/api/search-refs.ts";
import {
  EntryActionsMenu,
  QUOTE_REHYPE_PLUGINS,
} from "@/components/issue/entry-actions-menu.tsx";
import {
  StagedFileTray,
  StagedFileUploadButton,
  useStagedFiles,
} from "@/components/issue/staged-files.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { CommentHeaderMeta } from "@/components/shared/comment-header-meta.tsx";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useRefCompletion } from "@/lib/editor/ref-completion.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

export type Viewer = {
  id: number;
  isAdmin: boolean;
  /**
   * This reader's role in the project, null for a non-member. Carried
   * alongside `isAdmin` because hiding is a plain capability check against
   * the shared catalog (T-281), where editing is the narrower
   * author-or-admin rule below and cannot be expressed as one.
   */
  role?: MemberRole | null;
};

/**
 * What a comment write was aimed at, decided before its handler's first
 * `await` and carried through the mutation's variables. `Mutation.execute`
 * hands them to `fn` unchanged, so they survive the option swap a
 * route-param change performs on a mutation still pending — a closure's
 * `slug`/`issueNumber` do not, and a cross-project jump into a database
 * that reuses this comment id would overwrite the other card's comment.
 */
export type Target = { slug: string; issueNumber: number; commentId: number };

/** Mirror of the server rule: the author or a project admin may edit. */
export function canEditComment(
  viewer: Viewer | null | undefined,
  authorId: number,
): boolean {
  if (!viewer) return false;
  return viewer.isAdmin || viewer.id === authorId;
}

/** Mirror of the `comment.hide` gate: a writer, whoever wrote the comment. */
export function canHideComment(viewer: Viewer | null | undefined): boolean {
  return can(viewer?.role ?? null, "comment.hide");
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editor = useRef<MarkdownEditorHandle>(null);
  const [uploading, setUploading] = useState(false);
  const staging = useStagedFiles();
  const queryClient = useQueryClient();
  const refCompletion = useRefCompletion(slug);
  const target: Target = { slug, issueNumber, commentId: comment.id };
  const mayHide = canHideComment(viewer) && !isHidden(comment);
  const mayDelete = canEditComment(viewer, comment.author.id);
  const invalidateComment = (target: Target) => {
    queryClient.invalidateQueries({
      queryKey: ["timeline", target.slug, target.issueNumber],
    });
    // A migrated comment may be cached under any historical address. The
    // mutation supplies only its current one, so recheck search targets.
    void invalidateSearchRefQueries(queryClient);
  };
  const save = useMutation({
    mutationFn: (vars: Target & { body: string }) =>
      api.updateComment(vars.slug, vars.issueNumber, vars.commentId, vars.body),
    onSuccess: (_updated, vars) => {
      invalidateComment(vars);
      setEditing(false);
      staging.clear();
    },
    onError: (error) => toast.error(error.message),
  });
  const setHidden = useMutation({
    mutationFn: (vars: Target & { hidden: boolean }) =>
      api.setCommentsHidden(vars.slug, vars.issueNumber, {
        hidden: vars.hidden,
        comment_ids: [vars.commentId],
      }),
    onSuccess: (_result, vars) => invalidateComment(vars),
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (vars: Target) =>
      api.deleteComment(vars.slug, vars.issueNumber, vars.commentId),
    onSuccess: (_result, vars) => {
      setConfirmingDelete(false);
      return invalidateComment(vars);
    },
    onError: (error) => toast.error(error.message),
  });

  async function handleSave() {
    if (uploading) return;
    const body = (editor.current?.getValue() ?? comment.body).trimEnd();
    // `target` was read during render, before any of this: the upload below is
    // a real request, and by the time it answers the page may be showing
    // another card, whose comment of the same id this PATCH would overwrite.
    let full = body;
    if (staging.staged.length > 0) {
      setUploading(true);
      try {
        const markers = await staging.uploadAll(
          target.slug,
          target.issueNumber,
        );
        full = withAttachmentMarkers(body, markers);
      } catch (error) {
        toast.error(`Could not upload files: ${(error as Error).message}`);
        return;
      } finally {
        setUploading(false);
      }
    }
    save.mutate({ ...target, body: full });
  }

  return (
    <div
      // Anchor target for #comment-<id> permalinks; pending comments have
      // no server id yet, so they never claim an anchor.
      id={pending ? undefined : commentAnchor(comment.id)}
      className={`rounded-lg border ${pending ? "opacity-60" : ""}`}
      data-comment-id={comment.id}
    >
      <div className="flex flex-wrap items-baseline gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <UserChip user={comment.author} />
        {/* T-433's rule — text of different sizes shares one baseline —
            applied to the badge here, where T-435 put an id and a time on
            that same line. The icon opts out and stays centred because a
            replaced box has no baseline of its own: left in the group, the
            pill's position would be decided by a synthesized one taken from
            the glyph's box rather than by the model name beside it. Scoped
            to this call site; the event and revision rows keep T-433's
            self-center. */}
        <AgentContextBadge
          context={comment.agent_context}
          className="items-baseline [&>svg]:self-center"
        />
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
        {pending ? (
          <CommentHeaderMeta
            pending
            className="ml-auto"
            createdAt={comment.created_at}
          />
        ) : (
          <CommentHeaderMeta
            className="ml-auto"
            slug={slug}
            issueNumber={issueNumber}
            commentId={comment.id}
            createdAt={comment.created_at}
          />
        )}
        {pending && (
          <span className="text-xs text-muted-foreground">sending…</span>
        )}
        {!pending && (
          <div className="flex shrink-0 self-center items-center gap-0.5">
            {/* Both a mark and the way back: a reader who got here through
                a Reveal sees at once that this one is put away, and the
                same button restores it for everybody. Unreadable without
                the capability, but still shown — the mark is the point,
                and it is not a secret. */}
            {isHidden(comment) && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="unhide comment"
                disabled={!canHideComment(viewer) || setHidden.isPending}
                onClick={() => setHidden.mutate({ ...target, hidden: false })}
              >
                <EyeOffIcon className="size-3.5" />
              </Button>
            )}
            {canEditComment(viewer, comment.author.id) && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="edit comment"
                onClick={() => {
                  // The editor mounts fresh off comment.body each time edit
                  // mode opens, so an abandoned draft never survives into
                  // the next one.
                  staging.clear();
                  setEditing(!editing);
                }}
              >
                <PencilIcon className="size-3.5" />
              </Button>
            )}
            <EntryActionsMenu
              slug={slug}
              issueNumber={issueNumber}
              commentId={comment.id}
              body={comment.body}
              bodyRef={bodyRef}
              label="comment actions"
              triggerRef={menuTrigger}
            >
              {mayHide || mayDelete ? (
                <>
                  {mayHide && (
                    <DropdownMenuItem
                      onSelect={() =>
                        setHidden.mutate({ ...target, hidden: true })
                      }
                    >
                      <EyeOffIcon className="size-3.5" />
                      Hide comment
                    </DropdownMenuItem>
                  )}
                  {mayDelete && (
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setConfirmingDelete(true)}
                    >
                      <Trash2Icon className="size-3.5" />
                      Delete comment…
                    </DropdownMenuItem>
                  )}
                </>
              ) : null}
            </EntryActionsMenu>
          </div>
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
          <div ref={bodyRef}>
            <MarkdownView
              slug={slug}
              issueNumber={issueNumber}
              rehypePlugins={QUOTE_REHYPE_PLUGINS}
            >
              {comment.body}
            </MarkdownView>
          </div>
        )}
        {/* The component slot renders after the body and is immutable, so
            it stays put while the body above is edited. */}
        {!pending && !editing && comment.component?.type === "questions" && (
          <QuestionsCard
            slug={slug}
            issueNumber={issueNumber}
            commentId={comment.id}
            component={comment.component}
          />
        )}
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(next) => {
          setConfirmingDelete(next);
          // Radix hands focus back to the menu item that opened this, and
          // that item is gone — so it lands on <body>. The frame puts this
          // after radix's own restore; a synchronous focus loses to it.
          if (!next) requestAnimationFrame(() => menuTrigger.current?.focus());
        }}
        title="Delete this comment?"
        description={
          <>
            The comment is erased and cannot be brought back — comments have no
            trash the way issues do, and the edit history goes with it. To take
            it off the page while keeping it readable, use <strong>Hide</strong>{" "}
            instead.
          </>
        }
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(target)}
      />
    </div>
  );
}
