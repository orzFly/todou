import { cn } from "@orz/ui";
import { displayTitle } from "@todou/shared";

type TitleSource = { title: string; body_preview?: string | null };

export const NO_TITLE = "(no title given)";

/**
 * The string an untitled card (T-785) goes by wherever only text fits — a
 * browser tab, a `title` attribute, a filter: `(preview)`, or `(no title
 * given)` when the body has no plain text either.
 */
export function issueTitleText(item: TitleSource): string {
  const { text, untitled } = displayTitle(item);
  if (!untitled) return text;
  return text === "" ? NO_TITLE : `(${text})`;
}

/**
 * The container's classes for an untitled card's stand-in: one line, since
 * it is a cut of the body and wrapping it would only show more body, and
 * muted, since the ellipsis belongs to the block that overflows and takes
 * that block's colour rather than the inline span's.
 */
export function untitledLine(item: TitleSource): string | undefined {
  return displayTitle(item).untitled
    ? "truncate text-muted-foreground"
    : undefined;
}

/**
 * An issue's title, or an untitled card's muted stand-in. Inline and never a
 * link of its own, so it drops into one; the container keeps its own
 * `truncate` or `line-clamp`, and takes `untitledLine` for the ellipsis.
 */
export function IssueTitle({
  item,
  className,
}: {
  item: TitleSource;
  className?: string;
}) {
  const { untitled } = displayTitle(item);
  if (!untitled) return <>{item.title}</>;
  return (
    <span data-untitled className={cn("text-muted-foreground", className)}>
      {issueTitleText(item)}
    </span>
  );
}
