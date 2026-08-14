import { CheckCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { useMarkAllReadAction } from "@/api/reads.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Mark all read" (T-100). One button for both scopes of `PUT /me/read`:
 * with a `slug` it sweeps that project, without one every project the
 * caller can read.
 *
 * Always rendered, never disabled on an empty scope — the list page only
 * knows about the rows it has loaded, so "is there anything unread here?"
 * is not a question the client can answer, and a button that comes and
 * goes is worse than one that occasionally does nothing. Sweeping twice is
 * harmless: every write on the server is a `greatest`.
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
  const { mutate, isPending } = useMarkAllReadAction(slug);
  const scope = scopeName ?? (slug === undefined ? "everything" : slug);
  const label = `Mark ${scope} as read`;

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("text-muted-foreground", className)}
      disabled={isPending}
      title={label}
      aria-label={label}
      onClick={() =>
        mutate(undefined, {
          // Nothing visibly changes when the scope was already clean, so
          // say so — otherwise the click reads as a dead button.
          onSuccess: () => toast.success(`Marked ${scope} as read`),
        })
      }
    >
      <CheckCheckIcon className="size-3.5" />
      {!compact && <span>Mark all read</span>}
    </Button>
  );
}
