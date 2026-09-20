import { Link } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { USER_CHIP_NAME_INDENT } from "@/components/shared/user-chip.tsx";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils";

const TEXT = "shrink-0 text-xs whitespace-nowrap text-muted-foreground";

/**
 * A comment header's narrow-screen shape, merged into the row of all seven
 * entry points: who wrote it and what the reader may do share the first line,
 * and the id and the time get the second to themselves (T-445).
 *
 * Every class below the breakpoint and none above it, here and in the two
 * names under it. That is what makes "the desktop row is untouched" a
 * property of the code rather than a comparison somebody remembered to run —
 * T-426 let a narrow-screen concession reach the desktop, and T-443 had to
 * take it back. The column gap is restated rather than inherited so the row
 * gap next to it cannot depend on which of the two Tailwind emits last.
 */
export const COMMENT_HEADER_ROW =
  "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-2 max-sm:gap-y-0.5";

/**
 * Whatever a header's reader may do here: the timeline's action group,
 * `sending…`, `Resolve`, the `resolved` mark.
 */
export const COMMENT_HEADER_ACTION =
  "max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end max-sm:self-center";

/**
 * Everything that names the author — the chip, the agent badge, the edit
 * marker, a spec annotation's anchor.
 *
 * `contents` is load-bearing rather than tidy: above the breakpoint this
 * element generates no box at all, so the desktop row keeps exactly the flex
 * items it had before the group existed, and nothing in it can be pushed by
 * a wrapper that is not there. Below the breakpoint the group becomes a flex
 * box of its own and has to carry a gap again, because the row's `gap-2` no
 * longer reaches children this element now owns — without one the name and
 * the anchor render as a single run (`alice-quartermainfile · v1`).
 */
export const COMMENT_HEADER_IDENTITY =
  "contents max-sm:col-start-1 max-sm:row-start-1 max-sm:flex max-sm:min-w-0 max-sm:flex-wrap max-sm:items-baseline max-sm:gap-x-2 max-sm:gap-y-0.5";

export function CommentHeaderIdentity({ children }: { children: ReactNode }) {
  return <span className={COMMENT_HEADER_IDENTITY}>{children}</span>;
}

/**
 * Everything in a header that sits on one baseline — the identity group, the
 * meta, `sending…`, the `resolved` mark — held in a box of its own so that
 * the row can centre the lot of it.
 *
 * Flexbox lays a baseline-aligned group flush with the line's cross-start, so
 * as soon as one item is taller than the group — the action buttons always
 * are, being sized for a pointer rather than for text — every pixel of the
 * leftover falls below the names and none above them, and the header draws
 * its first line hard against the top of a box the buttons decide the height
 * of (T-487). Wrapping the baseline participants makes them one item, and
 * `self-center` then moves the group as a unit. Because nothing in the group
 * is taller than the header's own text any more, what ends up centred is the
 * text line, and the baseline lands where the header's text puts it.
 *
 * It has to be the group and not each participant. Centring them one by one
 * would put the id and the time off the author's baseline, because boxes of
 * different heights hold their baselines at different distances from their
 * own centres — and that baseline is what T-433 and T-435 are.
 *
 * `max-sm:contents` for the mirror of the reason `COMMENT_HEADER_IDENTITY` is
 * `contents` above the breakpoint: below it the row is a grid whose cells the
 * identity, the meta and the action claim for themselves, and a box around
 * two of the three would take one cell for both.
 */
export const COMMENT_HEADER_LINE =
  "flex min-w-0 grow flex-wrap items-baseline gap-2 self-center max-sm:contents";

export function CommentHeaderLine({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn(COMMENT_HEADER_LINE, className)}>{children}</span>;
}

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
  // the pair being squeezed a character per line. Right-justified above the
  // breakpoint, so the second line stays against the same edge as the first.
  const box = cn(
    "flex flex-wrap items-baseline justify-end gap-x-2",
    // The second line of the split header (T-445). `ml-0` is not tidiness:
    // the call site's `ml-auto` would, in a grid, shrink this to a
    // right-aligned box and carry the line's left edge with it. The base
    // `justify-end` goes the same way — it survives until the id and the
    // time need a line each, and then it sends the id 112px right of the
    // name it is supposed to start under.
    "max-sm:col-span-2 max-sm:row-start-2 max-sm:ml-0 max-sm:justify-start",
    "max-sm:ps-(--user-chip-name-indent)",
    // The time claims the leftover space rather than the row distributing
    // it, so running out of room drops it to a line of its own still against
    // the right edge. `justify-between` + `nowrap` draws the same shape and
    // fails by leaving the header, which is the one thing this card forbids.
    "max-sm:[&>*:last-child]:ml-auto",
    props.className,
  );
  // A custom property so the number stays beside the avatar it tracks
  // instead of being copied into the seven headers that indent by it.
  const indent = {
    "--user-chip-name-indent": USER_CHIP_NAME_INDENT,
  } as CSSProperties;

  if (props.pending) {
    return (
      <span className={box} style={indent} data-testid="comment-header-meta">
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
    <span className={box} style={indent} data-testid="comment-header-meta">
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
