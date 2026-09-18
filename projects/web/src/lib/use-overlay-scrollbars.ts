import { OverlayScrollbars, type PartialOptions } from "overlayscrollbars";
import { useEffect, useRef } from "react";

/**
 * Module-level so `ready` is the only thing the effect below closes over that
 * moves. Making an option follow state means `instance.options()`, not a
 * re-initialization.
 */
const OPTIONS: PartialOptions = {
  scrollbars: {
    theme: "os-theme-todou",
    autoHide: "leave",
    autoHideSuspend: true,
    // `false`, the library's default, makes a track click do nothing at all —
    // less than the native behaviour it replaces. Paging instead of jumping
    // would cost a `ClickScrollPlugin` registration.
    clickScroll: "instant",
  },
  // The column's own content never means to scroll sideways: titles use
  // `wrap-anywhere` and the meta row clips rather than wraps (T-303, T-361).
  // Tailwind's `overflow-y-auto` leaves the x axis computing to `auto`, so
  // without this the column is a horizontal scroll container too.
  overflow: { x: "hidden", y: "scroll" },
};

/**
 * Overlay scrollbars for a scroll container that stays exactly as it is: the
 * element `viewport` is on keeps its own classes, its own children and its own
 * native scrolling, and the bars are drawn in `slot`, a positioned parent
 * wrapped directly around it.
 *
 * Both refs are needed. Letting the library build its own viewport moves the
 * children into an inserted div, where the container's `flex gap` no longer
 * reaches them; leaving out the slot leaves the bars inside the scroll
 * container, where they scroll away with the content. A slot further out than
 * the immediate parent draws the bar over whatever else it spans.
 *
 * `ready` withholds the instance until the caller's content is in the DOM.
 * `autoHideSuspend` shows the bar once on arrival — but it only arms when the
 * element already overflows at the moment the instance is created, and a
 * column whose cards are still in flight does not. Initializing on mount
 * costs that one reveal outright. Until then the element scrolls natively.
 */
export function useOverlayScrollbars(ready: boolean) {
  const slot = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const slotElement = slot.current;
    const viewportElement = viewport.current;
    if (!ready || slotElement === null || viewportElement === null) return;
    const instance = OverlayScrollbars(
      {
        target: viewportElement,
        elements: { viewport: viewportElement },
        scrollbars: { slot: slotElement },
      },
      OPTIONS,
    );
    return () => instance.destroy();
  }, [ready]);

  return { slot, viewport };
}
