import { Link } from "@tanstack/react-router";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

const TEXT = "shrink-0 text-xs whitespace-nowrap text-muted-foreground";

/** Absolute and localised, as every other timestamp in the app already is. */
function CreatedTime({ createdAt }: { createdAt: string }) {
  return (
    <time dateTime={createdAt} title={createdAt}>
      {new Date(createdAt).toLocaleString()}
    </time>
  );
}

/**
 * The `#comment-N` and the creation time a comment's own header carries
 * (T-435), narrow on purpose: the author chip, the edited marker and the
 * action group stay with the call site, which is the only thing that knows
 * what this reader may do here.
 *
 * Both halves point at the comment in its own issue's timeline, never at the
 * spec document a spec comment is anchored to — the file/line links beside
 * them already go there, and one control cannot mean both.
 *
 * Deliberately not an `IssueLink`: the short suffix is the whole text, so
 * resolving a title would cost a request per rendered header and open a
 * preview inside a preview. A reference written *elsewhere* spells the issue
 * out (T-434); here the card around it already says which issue this is.
 */
export function CommentHeaderMeta(
  props: { createdAt: string; className?: string } & (
    | {
        /**
         * An optimistic comment has no persisted id — not a placeholder one,
         * which is why this branch cannot be handed a `commentId` to render.
         * The temporary ids the composer mints decrement (`-1 - key`), so
         * anything testing for `-1` instead would let the second unsent
         * comment of a session claim a permalink of its own.
         */
        pending: true;
      }
    | { pending?: false; slug: string; issueNumber: number; commentId: number }
  ),
) {
  const returnState = useReturnLinkState();
  // Wraps rather than shrinks: each half is `whitespace-nowrap`, so in a
  // container too narrow for both the time drops under the id instead of
  // the pair being squeezed a character per line. Right-justified so the
  // second line stays against the same edge as the first.
  const box = cn(
    "flex flex-wrap items-baseline justify-end gap-x-2",
    props.className,
  );

  if (props.pending) {
    return (
      <span className={box} data-testid="comment-header-meta">
        <span className={TEXT}>
          <CreatedTime createdAt={props.createdAt} />
        </span>
      </span>
    );
  }

  const { slug, issueNumber, commentId } = props;
  const target = {
    to: "/projects/$slug/issues/$number" as const,
    params: { slug, number: String(issueNumber) },
    hash: commentAnchor(commentId),
    // The anchor is a destination, not a scroll: arriving at it is
    // useTimelineAnchor's job, and it has collapsed runs to open first.
    hashScrollIntoView: false as const,
    state: returnState,
    className: cn(TEXT, "hover:underline"),
  };
  return (
    <span className={box} data-testid="comment-header-meta">
      <Link {...target}>
        {/* The one span the reader can select on its own, so a drag across it
            copies the suffix and nothing else — no author, no timestamp, and
            no issue ref quietly appended (T-427). */}
        <span className="select-all">{`#${commentAnchor(commentId)}`}</span>
      </Link>
      <Link {...target}>
        <CreatedTime createdAt={props.createdAt} />
      </Link>
    </span>
  );
}
