import { actionTextProblem, isHidden } from "@todou/shared";
import { AsteriskIcon, EyeOffIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/api/queries.ts";
import {
  EntryActionsMenu,
  QUOTE_REHYPE_PLUGINS,
} from "@/components/issue/entry-actions-menu.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { CommentHeaderMeta } from "@/components/shared/comment-header-meta.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { RevisionHistory } from "@/components/shared/revision-history.tsx";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  type CommentItemProps,
  canEditComment,
  canHideComment,
  type Target,
  useCommentWrites,
} from "@/components/timeline/comment-item.tsx";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { inlineActionSource } from "@/lib/action-text.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

/**
 * A `/me` line (T-575): one sentence that starts with its author's name, laid
 * out like an event row because that is the shape of a sentence on this
 * timeline, but in the body's colour, because a person wrote it. Every write a
 * comment offers is here too, since it is one.
 */
export function ActionItem({
  slug,
  issueNumber,
  comment,
  viewer = null,
  pending = false,
}: CommentItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const target: Target = { slug, issueNumber, commentId: comment.id };
  const mayEdit = canEditComment(viewer, comment.author.id);
  const mayHide = canHideComment(viewer) && !isHidden(comment);
  const { save, setHidden, remove } = useCommentWrites({
    onSaved: () => setEditing(false),
    onDeleted: () => setConfirmingDelete(false),
  });
  const problem = editing ? actionTextProblem(draft) : null;

  const submitEdit = () => {
    if (problem !== null || save.isPending) return;
    save.mutate({ ...target, body: draft.trim() });
  };

  return (
    <div
      id={pending ? undefined : commentAnchor(comment.id)}
      data-comment-id={comment.id}
      data-comment-kind="action"
      className={cn(
        "flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1.5 pl-1 text-sm",
        pending && "opacity-60",
      )}
    >
      {/* The event row's icon column, so names line up down the timeline. */}
      <span className="inline-flex shrink-0 self-start pt-1 text-muted-foreground/70">
        <AsteriskIcon className="size-3.5" />
      </span>
      <span className="inline-flex shrink-0 items-baseline gap-2">
        <UserChip
          user={comment.author}
          nameClassName="font-medium text-foreground"
        />
        <AgentContextBadge
          context={comment.agent_context}
          className="self-center"
        />
      </span>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 basis-64 flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitEdit();
          }}
        >
          <div className="flex gap-2">
            <Input
              autoFocus
              aria-label="Edit action"
              aria-invalid={problem !== null}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
              className="h-7"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={problem !== null || save.isPending}
            >
              Save
            </Button>
          </div>
          {problem !== null && draft.trim() !== "" && (
            <p className="text-xs text-destructive">{problem}</p>
          )}
        </form>
      ) : (
        <div
          ref={bodyRef}
          className="min-w-0 flex-1 basis-40 wrap-anywhere text-foreground [&_.markdown-body]:inline [&_p]:inline"
        >
          <MarkdownView
            slug={slug}
            issueNumber={issueNumber}
            rehypePlugins={QUOTE_REHYPE_PLUGINS}
          >
            {inlineActionSource(comment.body)}
          </MarkdownView>
        </div>
      )}
      <span className="ml-auto inline-flex shrink-0 items-baseline gap-2">
        {comment.edited_at && !pending && (
          <RevisionHistory
            label="action"
            editedAt={comment.edited_at}
            filename="action.md"
            queryKey={["revisions", slug, issueNumber, "comment", comment.id]}
            fetchRevisions={() =>
              api.getCommentRevisions(slug, issueNumber, comment.id)
            }
          />
        )}
        {pending ? (
          <>
            <CommentHeaderMeta unlinked createdAt={comment.created_at} />
            <span className="text-xs text-muted-foreground">sending…</span>
          </>
        ) : (
          <CommentHeaderMeta
            slug={slug}
            issueNumber={issueNumber}
            commentId={comment.id}
            createdAt={comment.created_at}
          />
        )}
      </span>
      {!pending && (
        <span className="flex shrink-0 items-center gap-0.5 self-center">
          {isHidden(comment) && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="unhide action"
              disabled={!canHideComment(viewer) || setHidden.isPending}
              onClick={() => setHidden.mutate({ ...target, hidden: false })}
            >
              <EyeOffIcon className="size-3.5" />
            </Button>
          )}
          {mayEdit && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="edit action"
              onClick={() => {
                setDraft(comment.body);
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
            label="action actions"
            triggerRef={menuTrigger}
          >
            {mayHide || mayEdit ? (
              <>
                {mayHide && (
                  <DropdownMenuItem
                    onSelect={() =>
                      setHidden.mutate({ ...target, hidden: true })
                    }
                  >
                    <EyeOffIcon className="size-3.5" />
                    Hide action
                  </DropdownMenuItem>
                )}
                {mayEdit && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setConfirmingDelete(true)}
                  >
                    <Trash2Icon className="size-3.5" />
                    Delete action…
                  </DropdownMenuItem>
                )}
              </>
            ) : null}
          </EntryActionsMenu>
        </span>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(next) => {
          setConfirmingDelete(next);
          // Same hand-back as a comment's: the item that opened this is gone.
          if (!next) requestAnimationFrame(() => menuTrigger.current?.focus());
        }}
        title="Delete this action?"
        description="It cannot be brought back — there is no trash for it."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(target)}
      />
    </div>
  );
}
