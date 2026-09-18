import { type ShouldBlockFn, useBlocker } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hasUnsavedWork } from "@/lib/unsaved-guard.ts";

/**
 * One guard for the whole app (T-317): a single `useBlocker` answers both
 * halves of "leaving". The history hands `enableBeforeUnload` the browser's
 * own `beforeunload` and lets it word the prompt, while `shouldBlockFn` is
 * asked before an in-app navigation commits — which is the last moment the
 * work still exists, since a later read would find the editor already rebuilt
 * from `initialValue` (see `markdown-editor.tsx`).
 *
 * Both predicates must keep one identity forever: `useBlocker` re-subscribes
 * whenever they change, so a fresh closure per render would churn the history
 * block on every keystroke. They close over nothing but the registry.
 */
export function UnsavedChangesGuard() {
  const shouldBlock = useCallback<ShouldBlockFn>(
    ({ current, next }) => hasUnsavedWork({ current, next }),
    [],
  );
  const shouldBlockUnload = useCallback(() => hasUnsavedWork(), []);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBlockUnload,
    withResolver: true,
  });

  if (blocker.status !== "blocked") return null;

  return (
    <Dialog
      open
      // Esc, the overlay and the close button all mean "I did not mean to
      // leave" — the navigation stays cancelled.
      onOpenChange={(open) => {
        if (!open) blocker.reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave with unsaved changes?</DialogTitle>
          <DialogDescription>
            There is text on this page that has not been submitted. Leaving now
            discards it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => blocker.proceed()}>
            Discard and leave
          </Button>
          <Button onClick={() => blocker.reset()}>Keep editing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
