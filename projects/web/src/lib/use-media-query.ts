import { useCallback, useSyncExternalStore } from "react";

/** Tailwind's `md` and `sm`. The one place these breakpoints are written outside CSS. */
export const MD_UP = "(min-width: 768px)";
export const SM_UP = "(min-width: 640px)";

/** Engines without `matchMedia` get the wide branch, the one that needs no second row. */
function evaluate(query: string): boolean {
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia(query).matches;
}

/**
 * Whether `query` matches, re-rendering when the answer changes.
 *
 * The snapshot is read during render rather than from an effect, so the
 * first frame already branches the right way. An effect would paint one
 * branch and correct it a frame later, which in the header reads as a flash.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onStoreChange);
      return () => list.removeEventListener("change", onStoreChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => evaluate(query));
}
