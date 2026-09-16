import { useQuery } from "@tanstack/react-query";
import { BellOffIcon, BellRingIcon } from "lucide-react";
import { mutesQuery, useMuteProject, useUnmuteProject } from "@/api/mutes.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Project-wide mute (T-372), shaped after MarkAllReadButton: the same
 * "act on the whole project" family, so it sits beside it in the list
 * toolbar and the board header, `compact` included.
 *
 * Reads the stored setting (mutesQuery) rather than deriving anything from
 * the page: project mute is one row in the settings, not a property of any
 * card this page happens to have loaded. Plain useQuery, not suspense —
 * the toolbar must render before the fetch lands, showing the unmuted
 * state.
 */
export function ProjectMuteButton({
  slug,
  compact = false,
  className,
}: {
  slug: string;
  /** Icon only — for tight spots, same contract as MarkAllReadButton. */
  compact?: boolean;
  className?: string;
}) {
  const { data } = useQuery(mutesQuery);
  const muteProject = useMuteProject();
  const unmuteProject = useUnmuteProject();
  const muted = (data?.projects ?? []).some((p) => p.slug === slug);
  const label = muted ? `Unmute ${slug}` : `Mute ${slug}`;

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("text-muted-foreground", className)}
      disabled={muteProject.isPending || unmuteProject.isPending}
      title={label}
      aria-label={label}
      onClick={() => (muted ? unmuteProject : muteProject).mutate({ slug })}
    >
      {muted ? (
        <BellOffIcon className="size-3.5" />
      ) : (
        <BellRingIcon className="size-3.5" />
      )}
      {!compact && <span>{muted ? "Unmute project" : "Mute project"}</span>}
    </Button>
  );
}
