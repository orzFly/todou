import { useSyncExternalStore } from "react";

/**
 * How an image comparison is drawn (T-722). Shared by every comparison on the
 * page, so switching one switches them all, and kept only for this page load:
 * a reload comes back to side by side.
 */
export type CompareMode = "2up" | "swipe" | "onion" | "diff";

let current: CompareMode = "2up";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setCompareMode(mode: CompareMode) {
  if (mode === current) return;
  current = mode;
  for (const listener of listeners) listener();
}

export function useCompareMode(): CompareMode {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => "2up",
  );
}

/** Tests only: back to the page-load default. */
export function resetCompareMode() {
  setCompareMode("2up");
}
