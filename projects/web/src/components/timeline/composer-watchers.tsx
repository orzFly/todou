import { formatRef, type Watcher } from "@todou/shared";
import { useState } from "react";
import { useRefPrefix } from "@/api/references.ts";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { WatcherPopover } from "@/components/shared/watcher-detail.tsx";
import {
  groupWatchers,
  sessionsSuffix,
  WatcherStack,
  watchingSentence,
} from "@/components/shared/watcher-stack.tsx";
import { cn } from "@/lib/utils";

/** "Comment — watched by Claude Agent (2 sessions) and Bot One". */
export function openerLabel(watchers: readonly Watcher[]): string {
  const names = groupWatchers(watchers).map(
    (group) => `${displayNameOf(group.user)}${sessionsSuffix(group)}`,
  );
  if (names.length === 0) return "Comment";
  const last = names.pop();
  const list = names.length === 0 ? last : `${names.join(", ")} and ${last}`;
  return `Comment — watched by ${list}`;
}

/**
 * The line above the composer while an agent watches this card (T-540): a
 * comment posted now reaches it at once, which nothing else on the page says.
 */
export function ComposerWatchersLine({
  slug,
  issueNumber,
  watchers,
  className,
}: {
  slug: string;
  issueNumber: number;
  watchers: readonly Watcher[];
  className?: string;
}) {
  const ref = formatRef(useRefPrefix(slug), issueNumber);
  // Inside the composer's DOM, which an empty box keys its folding off
  // (T-532): opening the list moves focus into it (T-580).
  const [host, setHost] = useState<HTMLElement | null>(null);
  if (watchers.length === 0) return null;
  return (
    <div
      ref={setHost}
      className={cn("flex", className)}
      data-composer-watchers=""
    >
      <WatcherPopover
        heading={`Watching ${ref}`}
        watchers={watchers}
        container={host}
        // Opaque to clicks over the see-through dock a folded phone composer
        // leaves behind, like the failed-send rows.
        className="pointer-events-auto min-w-0 gap-2 px-0.5 py-0.5 text-xs text-muted-foreground"
      >
        <WatcherStack watchers={watchers} size={16} pulse aria-hidden />
        <span className="min-w-0 truncate">
          {watchingSentence(groupWatchers(watchers))}
        </span>
        <span aria-hidden className="watcher-dots shrink-0">
          <span />
          <span />
          <span />
        </span>
      </WatcherPopover>
    </div>
  );
}
