import type { SpecVersionInfo } from "@todou/shared";
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import { displayNameOf, UserAvatar } from "@/components/shared/user-chip.tsx";
import { formatTimelineTime } from "@/lib/timeline-time.ts";

/**
 * Keeps one toast up for as long as `open` holds, drawing what `content`
 * draws about `current`, redrawn whenever `contentKey` changes. It stays until
 * the reader closes it, which reports `current` through `onReaderDismiss`;
 * the page taking it down is not that.
 */
export function useNewerVersionToast({
  open,
  current,
  content,
  contentKey,
  onReaderDismiss,
}: {
  open: boolean;
  current: number;
  /** Handed the toast's own close, for a close button inside it. */
  content: (close: () => void) => ReactNode;
  contentKey: string;
  onReaderDismiss: (current: number) => void;
}) {
  const base = useId();
  const latest = useRef({ content, onReaderDismiss });
  latest.current = { content, onReaderDismiss };
  // sonner calls onDismiss for toast.dismiss() too, and delivers that dismiss
  // a frame late. A fresh id per showing keeps a late dismiss from taking
  // down the next showing (StrictMode remounts at once), and its flag tells
  // the page's dismiss from the reader's.
  const showing = useRef<{ id: string; byPage: boolean } | null>(null);
  const serial = useRef(0);

  useEffect(() => {
    if (!open) return;
    const own = { id: `${base}:${++serial.current}`, byPage: false };
    showing.current = own;
    return () => {
      own.byPage = true;
      showing.current = null;
      toast.dismiss(own.id);
    };
  }, [open, base]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `contentKey` stands for `content`, which is new on every render.
  useEffect(() => {
    const own = showing.current;
    if (!open || own === null) return;
    // The same id again updates the toast in place.
    toast.custom(
      () => <>{latest.current.content(() => toast.dismiss(own.id))}</>,
      {
        id: own.id,
        duration: Number.POSITIVE_INFINITY,
        onDismiss: () => {
          if (!own.byPage) latest.current.onReaderDismiss(current);
        },
      },
    );
  }, [open, current, contentKey]);
}

/**
 * The newer version as its push left it: who, the message, when — the message
 * being the one thing about it the old version's page cannot show, and often
 * enough to decide whether to go. `action` is the way there.
 */
export function NewerVersionCard({
  version,
  onClose,
  action,
}: {
  version: SpecVersionInfo;
  onClose: () => void;
  action: ReactNode;
}) {
  return (
    <div className="grid w-full gap-2 rounded-lg border bg-popover px-3.5 pt-3 pb-3.5 text-popover-foreground text-sm shadow-lg ring-1 ring-foreground/5">
      <div className="flex min-w-0 items-center gap-2">
        <UserAvatar user={version.author} className="shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{displayNameOf(version.author)}</span>
          {" pushed "}
          <span className="font-semibold">
            <VersionNumber version={version.number} />
          </span>
        </p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-my-1 -mr-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="grid gap-2.5 pl-7">
        {version.message !== null && (
          <p className="line-clamp-2 wrap-anywhere">{version.message}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {action}
          <time
            dateTime={version.created_at}
            title={version.created_at}
            className="text-muted-foreground text-xs tabular-nums"
          >
            {formatTimelineTime(version.created_at)}
          </time>
        </div>
      </div>
    </div>
  );
}

/**
 * Keyed by the number, so a push that updates the toast in place swaps the
 * number in with a short rise while the card around it holds still.
 */
export function VersionNumber({ version }: { version: number }) {
  return (
    <span
      key={version}
      className="inline-block tabular-nums duration-250 ease-out animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none"
    >
      v{version}
    </span>
  );
}
