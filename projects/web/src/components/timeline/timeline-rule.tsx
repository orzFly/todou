import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A thin rule with its content sitting in the middle of it.
 *
 * Shared by the hidden-run placeholder and the timeline's own section line
 * (T-281) so the two cannot drift apart: they say related things — "this gap
 * holds N", "this card holds N" — and a reader has to see them as one
 * vocabulary rather than two decorations.
 */
export function TimelineRule({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 text-xs text-muted-foreground",
        className,
      )}
      {...rest}
    >
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * The one visual weight both reveal entries take: a text link, because they
 * change what this page shows rather than writing anything.
 */
export function RevealLink({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-foreground"
      onClick={onClick}
    >
      {label}
    </button>
  );
}
