import { cn } from "@orz/ui";
import { Button } from "@orz/ui/components/button";
import { ConfirmDialog } from "@orz/ui/components/confirm-dialog";
import { DropdownMenuItem } from "@orz/ui/components/dropdown-menu";
import { Textarea } from "@orz/ui/components/textarea";
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
import { useQuoteTarget } from "@/components/timeline/quote-reply.tsx";
import { inlineActionSource } from "@/lib/action-text.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import {
  formatTimelineTime,
  TIMELINE_ROW_NARROW,
  TIMELINE_TIME_NARROW,
} from "@/lib/timeline-time.ts";

/** EventRow's time, so the two cannot drift apart in size or colour. */
const TIME = cn(
  "shrink-0 text-xs whitespace-nowrap text-muted-foreground/70",
  TIMELINE_TIME_NARROW,
);

/**
 * From sm up the time shares a flex box with the `…`, and that box is aligned
 * to the sentence's first baseline (T-705). Set as a 12px line the time
 * carries a higher baseline than a 20px line of 14px text, and lining the two
 * up pushed the box, and with it the row, three pixels down. Set as the
 * sentence's line with only the `<time>` drawn small, it sits on that line's
 * baseline, as `TIMELINE_TIME_NARROW` does for the float.
 */
const TIME_ON_FIRST_LINE = "sm:text-sm sm:leading-5 sm:*:text-xs";

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
  const rowRef = useRef<HTMLDivElement>(null);
  const quoteRef = useQuoteTarget(comment.body, bodyRef, rowRef);
  const editInput = useRef<HTMLTextAreaElement>(null);
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
      {formatTimelineTime(comment.created_at)}
    </time>
  );

  // Below sm, EventRow's inline flow element for element. From sm up an event
  // is one truncated line, but an action is a sentence somebody wrote, up to
  // 500 characters, and a flex line made it a column of its own beside the
  // name, with the icon and the badge centred on the whole block (T-705). So
  // the name, badge and sentence share one paragraph that wraps back under
  // the avatar, and the icon, `…` and time hold the first line, the time on
  // the right edge where an event's is. The {" "} separators are for the
  // inline modes; whitespace between grid or flex items is never rendered.
  return (
    <div
      ref={rowRef}
      id={pending ? undefined : commentAnchor(comment.id)}
      data-comment-id={comment.id}
      data-comment-kind="action"
      className={cn(
        "py-1.5 pl-1 text-sm text-muted-foreground sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-baseline sm:gap-x-2",
        TIMELINE_ROW_NARROW,
        pending && "opacity-60",
      )}
    >
      <span className="inline-flex shrink-0 align-middle text-muted-foreground/70 sm:h-5 sm:items-center sm:self-start">
        <AsteriskIcon className="size-3.5" />
      </span>{" "}
      <div className="max-sm:inline">
        {/* A space plus these margins comes to the gap-2 an event row puts
            between the same three, within half a pixel. */}
        <span className="sm:me-1">
          <UserChip
            user={comment.author}
            nameClassName="font-medium text-foreground"
          />
        </span>{" "}
        <AgentContextBadge
          context={comment.agent_context}
          // A pixel taller than the line it sits in, so without the margins
          // the first line of a wrapped sentence came out taller than the rest.
          className="align-middle sm:-my-1 sm:me-1"
        />{" "}
        {editing ? (
          // A block, so it starts under the name and spans the column the
          // sentence wraps in: a 500-character line has to be readable while
          // it is edited, which a one-line input scrolling sideways is not.
          <form
            className="mt-1 flex min-w-0 flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              submitEdit();
            }}
          >
            {/* No autoFocus: the menu that opens this still holds a focus
                trap when it mounts, and takes the focus straight back. */}
            <Textarea
              ref={editInput}
              aria-label="Edit action"
              aria-invalid={problem !== null}
              value={draft}
              rows={1}
              // Still one line, only drawn wrapped: a pasted break becomes a
              // space, as it would in an input, and Enter saves.
              onChange={(e) =>
                setDraft(e.target.value.replace(/\r\n?|\n/g, " "))
              }
              onKeyDown={(e) => {
                if (e.key === "Escape") closeEditor();
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitEdit();
                }
              }}
              className="min-h-7 resize-none px-2.5 py-[3px] text-foreground md:leading-5"
            />
            <div className="flex items-start gap-2">
              {problem !== null && draft.trim() !== "" && (
                <p className="py-1.5 text-xs text-destructive">{problem}</p>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ms-auto"
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
          </form>
        ) : (
          <div
            ref={quoteRef}
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
      </div>
      {/* The time is last on a wide row, where every event's time lines up
          against the right edge, so the `…` sits before it there; below sm
          an event's time runs on from its sentence, and the `…` follows. */}
      <span className="max-sm:contents sm:flex sm:items-baseline sm:gap-2">
        {pending ? (
          <>
            <span className={cn(TIME, TIME_ON_FIRST_LINE, "sm:order-last")}>
              {time}
            </span>{" "}
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
              className={cn(
                TIME,
                TIME_ON_FIRST_LINE,
                "hover:underline sm:order-last",
              )}
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
                const input = editInput.current;
                if (input === null) return;
                input.focus();
                // An input's caret lands at the end; a textarea's at the start.
                input.setSelectionRange(input.value.length, input.value.length);
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
      </span>
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
