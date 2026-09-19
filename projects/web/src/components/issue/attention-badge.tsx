import { Link } from "@tanstack/react-router";
import type { BlockRef } from "@todou/shared";
import {
  AtSignIcon,
  BookOpenTextIcon,
  CirclePauseIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { BlockedHoverCard } from "@/components/shared/blocked-hover-card.tsx";
import { useReturnLinkState } from "@/components/shared/return-context.tsx";
import { UNANSWERED_QUESTIONS_HASH } from "@/lib/question-landing.ts";
import { cn } from "@/lib/utils";

/**
 * The amber "waiting on you" pill worn by issue rows, board cards and inbox
 * rows alike.
 *
 * Keep the label at icon + one token, and put the detail in `title`. The inbox
 * used to spell its reasons out ("spec v1 awaiting review", "question
 * waiting"); a row's trailing group never shrinks, so at 375px those two pills
 * squeezed the issue title to zero width and the row named no issue at all
 * (T-116).
 */
function AttentionBadge({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400",
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

export function QuestionBadge({
  slug,
  issueNumber,
  count,
  className,
}: {
  slug: string;
  issueNumber: number;
  count: number;
  className?: string;
}) {
  const returnState = useReturnLinkState();
  const label = `${count} unanswered question(s)`;
  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(issueNumber) }}
      hash={UNANSWERED_QUESTIONS_HASH}
      hashScrollIntoView={false}
      state={returnState}
      aria-label={label}
      className={cn(
        "inline-flex rounded-full hover:brightness-95 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <AttentionBadge title={label}>
        <MessageCircleQuestionIcon className="size-3.5" aria-hidden="true" />
        {count}
      </AttentionBadge>
    </Link>
  );
}

/**
 * "Something else has to happen first" (T-377), worn in the same places as
 * the two above.
 *
 * Deliberately NOT amber: this file's amber means "waiting on you", and a
 * blocked card is the opposite — it is waiting on somebody else, and nothing
 * the reader does to it now helps. Same shape, neutral colour, so the row
 * still scans as one family of pills.
 */
export function BlockedBadge({
  slug,
  blockedBy,
  className,
}: {
  slug: string;
  blockedBy: BlockRef[] | undefined;
  className?: string;
}) {
  const refs = (blockedBy ?? []).filter((ref) => ref.cleared_at === null);
  const count = refs.length;
  if (count === 0) return null;
  return (
    <BlockedHoverCard slug={slug} refs={refs}>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
          className,
        )}
        title={`waiting for ${count} other issue(s)`}
      >
        <CirclePauseIcon className="size-3.5" />
        {count}
      </span>
    </BlockedHoverCard>
  );
}

export function SpecReviewBadge({
  slug,
  issueNumber,
  version,
  className,
}: {
  slug: string;
  issueNumber: number;
  version: number | null;
  className?: string;
}) {
  const returnState = useReturnLinkState();
  return (
    <Link
      to="/projects/$slug/issues/$number/spec"
      params={{ slug, number: String(issueNumber) }}
      state={returnState}
      className={cn("inline-flex rounded-full hover:brightness-95", className)}
    >
      <AttentionBadge
        title={
          version === null
            ? "a spec is awaiting review"
            : `spec v${version} is awaiting review`
        }
      >
        <BookOpenTextIcon className="size-3.5" />
        spec
      </AttentionBadge>
    </Link>
  );
}

/**
 * The @-mention marker (T-373). Blue, not amber: the amber family is "work
 * waiting on you" (a question, a review); a mention is news about you, and
 * its colour sits with the unread markers that say the same thing.
 */
export function MentionBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-blue-500/60 bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-700 dark:text-blue-400",
        className,
      )}
      title="someone @-mentioned you here"
    >
      <AtSignIcon className="size-3.5" />
    </span>
  );
}
