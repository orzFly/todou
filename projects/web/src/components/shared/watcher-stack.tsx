import type { UserRef, Watcher } from "@todou/shared";
import type { ReactNode } from "react";
import {
  displayNameOf,
  LiveDot,
  UserAvatar,
} from "@/components/shared/user-chip.tsx";

export { LiveDot };

import { cn } from "@/lib/utils";

/** One account and every session it watches with. */
export type WatcherGroup = { user: UserRef; sessions: Watcher[] };

/**
 * The one place that decides "one avatar per account" (T-540): every agent on
 * a machine shares one account, so drawing per session would be a row of
 * identical faces. First-seen order, which the server sorts by `since`.
 */
export function groupWatchers(watchers: readonly Watcher[]): WatcherGroup[] {
  const groups = new Map<number, WatcherGroup>();
  for (const watcher of watchers) {
    const group = groups.get(watcher.user.id);
    if (group === undefined) {
      groups.set(watcher.user.id, { user: watcher.user, sessions: [watcher] });
    } else {
      group.sessions.push(watcher);
    }
  }
  return [...groups.values()];
}

export function sessionsSuffix(group: WatcherGroup): string {
  return group.sessions.length > 1
    ? ` (${group.sessions.length} sessions)`
    : "";
}

/** "Watching: Claude Agent (2 sessions), Bot One". */
export function watchingLabel(groups: readonly WatcherGroup[]): string {
  return `Watching: ${groups
    .map((group) => `${displayNameOf(group.user)}${sessionsSuffix(group)}`)
    .join(", ")}`;
}

/** The composer line's sentence, names in bold. */
export function watchingSentence(groups: readonly WatcherGroup[]): ReactNode {
  const name = (group: WatcherGroup) => (
    <>
      <span className="font-medium text-foreground">
        {displayNameOf(group.user)}
      </span>
      {sessionsSuffix(group)}
    </>
  );
  const [first, second] = groups;
  if (first === undefined) return null;
  if (second === undefined) return <>{name(first)} is watching this card</>;
  if (groups.length === 2) {
    return (
      <>
        {name(first)} and {name(second)} are watching this card
      </>
    );
  }
  return (
    <>
      {name(first)}, {name(second)} and {groups.length - 2} more are watching
      this card
    </>
  );
}

/** The green dot ahead of a stack; its ring animates unless motion is reduced. */
export function PulseDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "watcher-pulse relative inline-flex size-2 shrink-0 rounded-full bg-green-600 ring-3 ring-green-600/20",
        className,
      )}
    />
  );
}

const SIZES = {
  16: { avatar: "size-4", text: "[&_[data-slot=avatar-fallback]]:text-[7px]" },
  20: { avatar: "size-5", text: "" },
} as const;

/**
 * One avatar per watching account, overlapped, a count pill on an account
 * with several sessions. Renders nothing for an empty list, so a surface
 * never keeps an empty slot for it.
 */
export function WatcherStack({
  watchers,
  size = 20,
  pulse = false,
  live = false,
  max = 3,
  ringClassName = "ring-background",
  className,
  "aria-hidden": ariaHidden,
}: {
  watchers: readonly Watcher[];
  size?: 16 | 20;
  pulse?: boolean;
  /**
   * Each avatar carries its own live dot, as on a list row, instead of one
   * pulse ahead of the stack (T-542). The avatars stop overlapping, because
   * the next one would cover the dot.
   */
  live?: boolean;
  max?: number;
  /** The overlap ring takes the surface's colour; a dark button passes its own. */
  ringClassName?: string;
  className?: string;
  "aria-hidden"?: boolean;
}) {
  const groups = groupWatchers(watchers);
  if (groups.length === 0) return null;
  const shown = groups.slice(0, max);
  const hidden = groups.length - shown.length;
  const dims = SIZES[size] ?? SIZES[20];
  const box = cn("inline-flex shrink-0 items-center", className);
  const content = (
    <>
      {pulse && <PulseDot className="me-1.5" />}
      {shown.map((group, index) => {
        const sessions = group.sessions.length;
        // An avatar after a count pill steps aside instead of covering it.
        const afterPill =
          index > 0 && (shown[index - 1]?.sessions.length ?? 0) > 1;
        return (
          <span
            key={group.user.id}
            className={cn(
              "relative inline-flex",
              index > 0 && (afterPill || live ? "ms-1.5" : "-ms-1"),
            )}
          >
            <UserAvatar
              user={group.user}
              className={cn(
                dims.avatar,
                dims.text,
                !live && ["ring-2", ringClassName],
              )}
            />
            {live && <LiveDot className={ringClassName} />}
            {sessions > 1 && (
              <span
                data-session-count=""
                className="absolute -right-1 -bottom-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 text-[8px] font-semibold leading-none text-background"
              >
                {sessions}
              </span>
            )}
          </span>
        );
      })}
      {hidden > 0 && (
        <span className="ms-1 text-[10px] font-medium text-muted-foreground">
          +{hidden}
        </span>
      )}
    </>
  );
  // Hidden where a control around it already says who is watching.
  if (ariaHidden) {
    return (
      <span aria-hidden className={box}>
        {content}
      </span>
    );
  }
  return (
    <span role="img" aria-label={watchingLabel(groups)} className={box}>
      {content}
    </span>
  );
}
