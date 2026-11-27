import { cn } from "@orz/ui";
import { Button } from "@orz/ui/components/button";
import { CheckCheckIcon } from "lucide-react";
import { useMarkAllReadAction } from "@/api/reads.ts";

/**
 * "Mark all read" (T-100). One button for both scopes of `PUT /me/read`:
 * with a `slug` it sweeps that project, without one every project the
 * caller can read.
 *
 * Always rendered, never disabled on an empty scope — the list page only
 * knows about the rows it has loaded, so "is there anything unread here?"
 * is not a question the client can answer, and a button that comes and
 * goes is worse than one that occasionally does nothing. Sweeping twice is
 * harmless: positions only move forward.
 */
export function MarkAllReadButton({
  slug,
  scopeName,
  compact = false,
  className,
}: {
  /** Omitted = every project I can read (the inbox's own scope). */
  slug?: string;
  /** What the sweep covers, for the accessible name. */
  scopeName?: string;
  /** Icon only — for tight spots like the inbox group headers. */
  compact?: boolean;
  className?: string;
}) {
  const { mutate, isPending } = useMarkAllReadAction();
  const scope = scopeName ?? (slug === undefined ? "everything" : slug);
  const label = `Mark ${scope} as read`;

  return (
    <Button
      variant="ghost"
      size={compact ? "icon-sm" : "sm"}
      className={cn("text-muted-foreground", className)}
      disabled={isPending}
      title={label}
      aria-label={label}
      onClick={() => mutate({ slug, scope })}
    >
      <CheckCheckIcon className="size-3.5" />
      {!compact && <span>Mark all read</span>}
    </Button>
  );
}
