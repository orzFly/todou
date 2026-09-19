import { useCallback, useSyncExternalStore } from "react";

/** Tailwind's `md` and `sm`. The one place these breakpoints are written outside CSS. */
export const MD_UP = "(min-width: 768px)";
export const SM_UP = "(min-width: 640px)";

/**
 * Where the centred column leaves a gutter wide enough to hang a control in
 * (T-461). `<main>` is `max-w-6xl`, so from 1152px up the column stops growing
 * and every pixel of viewport past it becomes margin: 24px each side at
 * 1200px, 144px at 1440px, 384px at 1920px. A container query cannot ask this
 * — the column, and therefore every box inside it, measures the same at all
 * three — which is why the question is a viewport one however much the rest
 * of a component's responsiveness is not.
 */
export const XL_UP = "(min-width: 1440px)";

/**
 * A mouse-like primary pointer. Asked this way round, and about `pointer`
 * rather than `any-pointer`, for two reasons:
 *
 * - the fallback below answers `true` to everything, so the query has to be
 *   the one whose `true` is the desktop branch;
 * - `any-pointer: coarse` flips a touchscreen laptop, whose primary pointer
 *   is a mouse, onto the touch branch for good.
 */
export const POINTER_FINE = "(pointer: fine)";

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
