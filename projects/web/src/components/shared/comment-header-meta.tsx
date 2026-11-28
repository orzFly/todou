import { cn } from "@orz/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import { formatTimelineTime } from "@/lib/timeline-time.ts";

const TEXT = "text-xs whitespace-nowrap text-muted-foreground";

/**
 * Whatever draws one whole comment — the timeline card, a preview, an
 * annotation bubble. Pointing anywhere inside it, or moving the focus into
 * it, is what brings the header's `#comment-N` out (T-696).
 */
export const COMMENT_SURFACE = "group/comment";

/**
 * A comment header's narrow-screen shape, merged into the row of all seven
 * entry points: the text line takes the first column and whatever the reader
 * may do takes the second, so the buttons hold the top-right corner however
 * the text wraps.
 *
 * Every class below the breakpoint and none above it, here and in the two
 * names under it. That is what makes "the desktop row is untouched" a
 * property of the code rather than a comparison somebody remembered to run —
 * T-426 let a narrow-screen concession reach the desktop, and T-443 had to
 * take it back.
 */
export const COMMENT_HEADER_ROW =
  "max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-2";

/**
 * Whatever a header's reader may do here: the timeline's action group, a
 * spec annotation's `Resolve`.
 *
 * `self-start`, not centred: on one line the buttons are what make the row
 * as tall as it is, so the two come out the same, and once the time has
 * wrapped, centring would leave the buttons hanging between the author and
 * the time instead of on the author's line.
 */
export const COMMENT_HEADER_ACTION =
  "max-sm:col-start-2 max-sm:row-start-1 max-sm:justify-self-end max-sm:self-start";

/**
 * Everything that names the author — the chip, the agent badge, the edit
 * marker, a spec annotation's anchor.
 *
 * `contents` is load-bearing rather than tidy: above the breakpoint this
 * element generates no box at all, so the desktop row keeps exactly the flex
 * items it had before the group existed, and nothing in it can be pushed by
 * a wrapper that is not there. Below the breakpoint the group is one flex
 * item of the line, which is what lets the line ask a single question — do
 * the author and the time fit side by side — and move only the time when
 * they do not (T-696). It does not wrap inside: what runs out of room is the
 * badge and the name, which truncate, so the author never takes two lines
 * and pushes the time to a third. An anchor holds its line by
 * `COMMENT_HEADER_ANCHOR`.
 *
 * A state mark — `outdated`, `resolved` — sits beside the group, never in
 * it. It is one word that cannot shrink, so inside the group it would take
 * its width from the anchor, and an `outdated` comment at 320px would run
 * the header 12px into its Resolve button (T-826). Beside the group it
 * wraps the way the time does.
 */
export const COMMENT_HEADER_IDENTITY =
  "contents max-sm:flex max-sm:min-w-0 max-sm:items-baseline max-sm:gap-x-2";

/**
 * A spec annotation's anchor — `file · v1`, `L3–8 · v2` — inside the
 * identity group.
 *
 * Unshrinkable, so the author's name is what gives way: an ordinary flex
 * item is squeezed in proportion to its width, and an anchor allowed to
 * wrap at its spaces stood `file`, `·` and `v1` on three lines of their own
 * while the name beside it still had letters to spare (T-826).
 *
 * The cap is the last resort, for when the name is down to its avatar and
 * the anchor still does not fit: it wraps in the width that is left instead
 * of running over the Resolve button. 1.75rem is that avatar — the chip's
 * `min-w-5` — plus the group's `gap-x-2`, and has to move with either.
 */
export const COMMENT_HEADER_ANCHOR =
  "max-sm:shrink-0 max-sm:max-w-[calc(100%-1.75rem)]";

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
 * Below the breakpoint the line is the grid's first cell. One line while the
 * author and the time fit beside each other, and the time wraps under them
 * only when they do not — the narrow gap is the one between those two lines.
 */
export const COMMENT_HEADER_LINE =
  "flex min-w-0 grow flex-wrap items-baseline gap-2 self-center max-sm:col-start-1 max-sm:row-start-1 max-sm:gap-y-0.5";

export function CommentHeaderLine({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn(COMMENT_HEADER_LINE, className)}>{children}</span>;
}

/** Localised, as every other timestamp in the app is; the ISO on hover. */
function CreatedTime({ createdAt }: { createdAt: string }) {
  return (
    <time dateTime={createdAt} title={createdAt}>
      {formatTimelineTime(createdAt)}
    </time>
  );
}

/**
 * The creation time a comment's own header carries, and behind it the
 * comment's `#comment-N` (T-435), narrow on purpose: the author chip, the
 * edited marker and the action group stay with the call site, which is the
 * only thing that knows what this reader may do here.
 *
 * The id is out of sight until it is wanted (T-696): pointing at the comment,
 * focus inside it, or this comment being the one the address names — and on
 * a narrow screen it is never shown at all. It is
 * never shortened to `#N` to save the room — in a body that spelling is an
 * issue reference, so a reader who copied it would be pointing somewhere
 * else entirely.
 *
 * One link around both, to the comment in its own issue's timeline, never to
 * the spec document a spec comment is anchored to — the file/line links
 * beside it already go there, and one control cannot mean both.
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
         * Nothing to point at, so the time stands alone.
         *
         * An optimistic comment has no persisted id — not a placeholder one,
         * which is why this branch cannot be handed a `commentId` to render.
         * The temporary ids the composer mints decrement (`-1 - key`), so
         * anything testing for `-1` instead would let the second unsent
         * comment of a session claim a permalink of its own.
         *
         * The issue body takes the same branch for a different reason: it is
         * not a comment, and the card around it is already where a permalink
         * would send the reader.
         */
        unlinked: true;
      }
    | {
        unlinked?: false;
        slug: string;
        issueNumber: number;
        commentId: number;
      }
  ),
) {
  // Wraps rather than squeezes: each half is `whitespace-nowrap`, so in a
  // container too narrow for both the time drops under the id instead of
  // the pair being squeezed a character per line. That takes a box free to
  // shrink — no `shrink-0` here, or a five-digit id and the time hold one
  // line and run past the header at 320px. Right-justified, so a
  // second line stays against the same edge as the first. `max-sm:ml-auto`
  // because the two spec rows push the meta right with a spacer of their
  // own, which is gone below the breakpoint.
  const box = cn(
    "flex flex-wrap items-baseline justify-end gap-x-2 max-sm:ml-auto",
    props.className,
  );

  if (props.unlinked) {
    return (
      <span className={cn(box, TEXT)} data-testid="comment-header-meta">
        <CreatedTime createdAt={props.createdAt} />
      </span>
    );
  }

  return <LinkedMeta {...props} box={box} />;
}

function LinkedMeta({
  slug,
  issueNumber,
  commentId,
  createdAt,
  box,
}: {
  slug: string;
  issueNumber: number;
  commentId: number;
  createdAt: string;
  box: string;
}) {
  const returnState = useReturnLinkState();
  const anchor = commentAnchor(commentId);
  // Read off the address rather than off the timeline's landing: CSS
  // `:target` would do it for free, but the router moves between hashes
  // with pushState, which `:target` never sees. The selector returns a
  // boolean, so a header re-renders when its own answer flips and not on
  // every navigation.
  const named = useRouterState({
    select: (s) =>
      s.location.hash === anchor &&
      s.location.pathname === `/projects/${slug}/issues/${issueNumber}`,
  });
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(issueNumber) }}
      hash={anchor}
      // The anchor is a destination, not a scroll: arriving at it is
      // useTimelineAnchor's job, and it has collapsed runs to open first.
      hashScrollIntoView={false}
      state={returnState}
      className={cn(box, TEXT, "group/meta")}
      data-testid="comment-header-meta"
    >
      {/* The one span the reader can select on its own, so a drag across it
          copies the suffix and nothing else — no author, no timestamp, and
          no issue ref quietly appended (T-427).

          Hidden with opacity and not removed, above the breakpoint: the
          space stays held, so pointing at a comment never moves its time
          or wraps its header. Below it the id is never drawn, not even on
          the comment the address names: there is no pointer to bring it
          back, every pixel of the first line is spoken for, and the menu's
          Copy reference is how a phone reaches it. */}
      <span
        className={cn(
          "select-all max-sm:hidden",
          !named &&
            "opacity-0 transition-opacity duration-150 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 motion-reduce:transition-none",
        )}
      >{`#${anchor}`}</span>
      <span className="group-hover/meta:underline">
        <CreatedTime createdAt={createdAt} />
      </span>
    </Link>
  );
}
