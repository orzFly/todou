import { BookOpenTextIcon, MessageCircleQuestionIcon } from "lucide-react";
import type { ReactNode } from "react";
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
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  return (
    <AttentionBadge
      title={`${count} unanswered question(s)`}
      className={className}
    >
      <MessageCircleQuestionIcon className="size-3.5" />
      {count}
    </AttentionBadge>
  );
}

export function SpecReviewBadge({
  version,
  className,
}: {
  version: number | null;
  className?: string;
}) {
  return (
    <AttentionBadge
      title={
        version === null
          ? "a spec is awaiting review"
          : `spec v${version} is awaiting review`
      }
      className={className}
    >
      <BookOpenTextIcon className="size-3.5" />
      spec
    </AttentionBadge>
  );
}
