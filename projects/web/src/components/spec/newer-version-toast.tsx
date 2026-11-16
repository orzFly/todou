import { type ReactNode, useEffect, useId, useRef } from "react";
import { toast } from "sonner";

/**
 * Keeps one toast up for as long as `open` holds, saying what `content` says
 * about `current`, redrawn whenever `contentKey` changes. It stays until the
 * reader closes it, which reports `current` through `onReaderDismiss`; the
 * page taking it down is not that.
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
  content: ReactNode;
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
    toast(latest.current.content, {
      id: own.id,
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      onDismiss: () => {
        if (!own.byPage) latest.current.onReaderDismiss(current);
      },
    });
  }, [open, current, contentKey]);
}
