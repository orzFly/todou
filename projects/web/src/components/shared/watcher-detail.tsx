import type { Watcher } from "@todou/shared";
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { compactAge } from "@/components/issue/metadata-section.tsx";
import { AgentContextBadge } from "@/components/shared/agent-badge.tsx";
import {
  CLOSE_DELAY_MS,
  OPEN_DELAY_MS,
} from "@/components/shared/hover-preview.ts";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { cn } from "@/lib/utils";

/** What one session holds open, in the words of the command that opened it. */
export function watchingWhat(watcher: Watcher): string {
  if (watcher.kind === "spec_wait") return "spec wait";
  if (watcher.kind === "question_wait") return "question wait";
  if (watcher.scope === "all_projects") return "all projects";
  if (watcher.scope === "project") return "whole project";
  return "this card";
}

/** One row per session, oldest first. */
export function WatcherDetail({
  heading,
  watchers,
}: {
  heading: string;
  watchers: readonly Watcher[];
}) {
  const rows = [...watchers].sort(
    (a, b) => Date.parse(a.since) - Date.parse(b.since),
  );
  return (
    <div>
      <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
        {heading}
      </p>
      <ul className="space-y-0.5">
        {rows.map((watcher) => (
          <li
            key={`${watcher.user.id}/${watcher.agent_context.session_id ?? watcher.since}/${watcher.kind}/${watcher.scope}`}
            className="flex min-w-0 items-center gap-2 px-2 py-1 text-sm"
          >
            <UserAvatar user={watcher.user} badge className="shrink-0" />
            <span className="min-w-0 shrink truncate">
              {displayNameOf(watcher.user)}
            </span>
            <AgentContextBadge context={watcher.agent_context} />
            <span className="ms-auto shrink-0 ps-2 text-xs whitespace-nowrap text-muted-foreground">
              {watchingWhat(watcher)} · {compactAge(watcher.since)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A real button that opens the session list: on hover with the preview
 * delay where a pointer can hover, on a tap everywhere. The toggle is done
 * here rather than by Radix because the projects home puts this inside a
 * card that is a link, where the click has to be kept from navigating, and
 * a prevented click is one Radix ignores.
 */
export function WatcherPopover({
  heading,
  watchers,
  label,
  className,
  children,
  ...props
}: {
  heading: string;
  watchers: readonly Watcher[];
  /** Absent when the content already reads as the label. */
  label?: string;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "children">) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const later = (next: boolean, ms: number) => {
    clear();
    timer.current = setTimeout(() => setOpen(next), ms);
  };
  const hoverOnly =
    (handler: () => void) => (event: { pointerType: string }) => {
      if (event.pointerType === "mouse") handler();
    };
  if (watchers.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex cursor-pointer items-center rounded-md",
            className,
          )}
          onPointerEnter={hoverOnly(() => later(true, OPEN_DELAY_MS))}
          onPointerLeave={hoverOnly(() => later(false, CLOSE_DELAY_MS))}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            clear();
            setOpen((was) => !was);
          }}
          {...props}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto max-w-[min(26rem,calc(100vw-1rem))] min-w-64"
        onPointerEnter={hoverOnly(clear)}
        onPointerLeave={hoverOnly(() => later(false, CLOSE_DELAY_MS))}
        // Board cards are draggable, and portal events still bubble through
        // the React tree.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <WatcherDetail heading={heading} watchers={watchers} />
      </PopoverContent>
    </Popover>
  );
}
