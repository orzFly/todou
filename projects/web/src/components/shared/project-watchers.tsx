import { useQuery } from "@tanstack/react-query";
import type { Watcher } from "@todou/shared";
import { projectQuery, projectWatchersQuery } from "@/api/queries.ts";
import { WatcherPopover } from "@/components/shared/watcher-detail.tsx";
import {
  groupWatchers,
  WatcherStack,
  watchingLabel,
} from "@/components/shared/watcher-stack.tsx";
import { cn } from "@/lib/utils";

/** A project's project-level watchers as a pulsing stack that opens the session list. */
export function ProjectWatchersButton({
  projectName,
  watchers,
  className,
}: {
  projectName: string;
  watchers: readonly Watcher[];
  className?: string;
}) {
  if (watchers.length === 0) return null;
  return (
    <WatcherPopover
      heading={`Watching ${projectName}`}
      watchers={watchers}
      label={watchingLabel(groupWatchers(watchers))}
      className={className}
    >
      <WatcherStack watchers={watchers} pulse aria-hidden />
    </WatcherPopover>
  );
}

/**
 * The list and board toolbar's chip. Renders nothing while the read is
 * pending, failed or empty: presence is decoration, and an error state would
 * be louder than the feature.
 */
export function ProjectWatchersChip({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const watchers = useQuery(projectWatchersQuery(slug)).data?.project ?? [];
  const name = useQuery(projectQuery(slug)).data?.name ?? slug;
  // No wrapper at all when empty: an empty flex item would still take a gap,
  // and on a phone a line of its own.
  if (watchers.length === 0) return null;
  return (
    <span className={cn("flex", className)}>
      <ProjectWatchersButton
        projectName={name}
        watchers={watchers}
        // The height of the `size="sm"` ghost buttons beside it, so the row
        // keeps its shape.
        className="h-7 px-1.5 hover:bg-accent"
      />
    </span>
  );
}
