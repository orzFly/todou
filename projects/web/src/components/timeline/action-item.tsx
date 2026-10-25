import { Link } from "@tanstack/react-router";
import { actionTextProblem, isHidden } from "@todou/shared";
import {
  AsteriskIcon,
  EyeIcon,
  EyeOffIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";
import { api } from "@/api/queries.ts";
import {
  EntryActionsMenu,
  QUOTE_REHYPE_PLUGINS,
} from "@/components/issue/entry-actions-menu.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
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

/** EventRow's time, so the two cannot drift apart in size or colour. */
const TIME = "shrink-0 text-xs whitespace-nowrap text-muted-foreground/70";

/**
 * A `/me` line (T-575): one sentence that starts with its author's name, laid
 * out like an event row because that is the shape of a sentence on this
 * timeline, but in the body's colour, because a person wrote it. Every write a
 * comment offers is here too, since it is one — all of them behind the `…`,
 * because a pencil beside the time is what made the row read as a comment
 * card with its border taken off (T-579).
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
  const editInput = useRef<HTMLInputElement>(null);
  /** Set by Edit action, so closing the menu hands the focus to the input. */
  const openingEditor = useRef(false);
  const returnState = useReturnLinkState();
  const target: Target = { slug, issueNumber, commentId: comment.id };
  const mayEdit = canEditComment(viewer, comment.author.id);
  const mayHide = canHideComment(viewer) && !isHidden(comment);
  const mayUnhide = canHideComment(viewer) && isHidden(comment);
  // The editor was opened from inside a menu that has since closed, so
  // without this the focus would fall to the document.
  const closeEditor = () => {
    setEditing(false);
    requestAnimationFrame(() => menuTrigger.current?.focus());
  };
  const { save, setHidden, remove } = useCommentWrites({
    onSaved: closeEditor,
    onDeleted: () => setConfirmingDelete(false),
  });
  const problem = editing ? actionTextProblem(draft) : null;

  const submitEdit = () => {
    if (problem !== null || save.isPending) return;
    save.mutate({ ...target, body: draft.trim() });
  };

  const time = (
    <time dateTime={comment.created_at} title={comment.created_at}>
      {new Date(comment.created_at).toLocaleString()}
    </time>
  );

  // EventRow's classes, element for element: inline flow below sm, one
  // baseline-aligned flex line from sm up. The {" "} separators are for the
  // inline mode, as there.
  return (
    <div
      id={pending ? undefined : commentAnchor(comment.id)}
      data-comment-id={comment.id}
      data-comment-kind="action"
      className={cn(
        "py-1.5 pl-1 text-sm text-muted-foreground sm:flex sm:items-baseline sm:gap-2",
        pending && "opacity-60",
      )}
    >
      <span className="inline-flex shrink-0 align-middle text-muted-foreground/70 sm:self-center">
        <AsteriskIcon className="size-3.5" />
      </span>{" "}
      <UserChip
        user={comment.author}
        nameClassName="font-medium text-foreground"
      />{" "}
      <AgentContextBadge
        context={comment.agent_context}
        className="align-middle sm:self-center"
      />{" "}
      {editing ? (
        <form
          className="mt-1 flex min-w-0 flex-col gap-1 sm:mt-0 sm:flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            submitEdit();
          }}
        >
          <div className="flex gap-2">
            {/* No autoFocus: the menu that opens this still holds a focus
                trap when it mounts, and takes the focus straight back. */}
            <Input
              ref={editInput}
              aria-label="Edit action"
              aria-invalid={problem !== null}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeEditor();
              }}
              className="h-7"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closeEditor}
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
          // The prose line height a markdown body brings along would make
          // this line taller than an event's.
          className="inline min-w-0 flex-1 wrap-anywhere text-foreground [&_.markdown-body]:inline [&_.markdown-body]:leading-[inherit] [&_p]:inline"
        >
          <MarkdownView
            slug={slug}
            issueNumber={issueNumber}
            rehypePlugins={QUOTE_REHYPE_PLUGINS}
          >
            {inlineActionSource(comment.body)}
          </MarkdownView>
        </div>
      )}{" "}
      {comment.edited_at && !pending && (
        <>
          <RevisionHistory
            label="action"
            editedAt={comment.edited_at}
            filename="action.md"
            queryKey={["revisions", slug, issueNumber, "comment", comment.id]}
            fetchRevisions={() =>
              api.getCommentRevisions(slug, issueNumber, comment.id)
            }
          />{" "}
        </>
      )}
      {/* The time is last on a wide row, where every event's time lines up
          against the right edge, so the `…` sits before it there; below sm
          an event's time runs on from its sentence, and the `…` follows. */}
      {pending ? (
        <>
          <span className={cn(TIME, "sm:order-last")}>{time}</span>{" "}
          <span className="text-xs">sending…</span>
        </>
      ) : (
        <>
          <Link
            to="/projects/$slug/issues/$number"
            params={{ slug, number: String(issueNumber) }}
            hash={commentAnchor(comment.id)}
            hashScrollIntoView={false}
            state={returnState}
            className={cn(TIME, "hover:underline sm:order-last")}
          >
            {time}
          </Link>{" "}
          <EntryActionsMenu
            slug={slug}
            issueNumber={issueNumber}
            commentId={comment.id}
            body={comment.body}
            bodyRef={bodyRef}
            label="action actions"
            triggerRef={menuTrigger}
            // One line tall, so the row is exactly as tall as an event's.
            // Inline, a middle-aligned box that tall still pokes out of the
            // line box; the negative margin keeps it from counting.
            triggerClassName="-my-1 size-5 align-middle text-muted-foreground/70 sm:my-0 sm:self-center"
            onCloseAutoFocus={(e) => {
              if (!openingEditor.current) return;
              openingEditor.current = false;
              e.preventDefault();
              editInput.current?.focus();
            }}
          >
            {mayEdit || mayHide || mayUnhide ? (
              <>
                {mayEdit && (
                  <DropdownMenuItem
                    onSelect={() => {
                      openingEditor.current = true;
                      setDraft(comment.body);
                      setEditing(true);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                    Edit action
                  </DropdownMenuItem>
                )}
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
                {mayUnhide && (
                  <DropdownMenuItem
                    disabled={setHidden.isPending}
                    onSelect={() =>
                      setHidden.mutate({ ...target, hidden: false })
                    }
                  >
                    <EyeIcon className="size-3.5" />
                    Unhide action
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
        </>
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
