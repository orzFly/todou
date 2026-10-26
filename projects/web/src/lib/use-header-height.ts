import { useEffect, useState } from "react";

/** The shell header's desktop height, until the measurement lands. */
const FALLBACK_HEADER_HEIGHT = 56;

/**
 * How far a layer pinned beneath the header tucks up under its bottom border.
 * Firefox at a fractional zoom (175%) can snap the header and the layer under
 * it to different device-pixel rows, leaving one row of page showing between
 * them; headless Firefox and Chromium never do, so no automated check here
 * sees it (T-480, T-595). The header paints above every such layer, so the
 * overlap is hidden behind the border.
 */
const BORDER_OVERLAP = 1;

/**
 * The live height of the shell header, less `BORDER_OVERLAP`, for anything
 * that has to sit directly beneath it. The header carries a second row of nav
 * below sm, so its height is a runtime value no CSS offset can name — measure
 * it, as the issue list's group headers do.
 */
export function useHeaderHeight(): number {
  const [headerHeight, setHeaderHeight] = useState(FALLBACK_HEADER_HEIGHT);

  useEffect(() => {
    const appbar = document.querySelector("header");
    if (appbar === null) return;
    const measure = () =>
      setHeaderHeight(appbar.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(appbar);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, []);

  return headerHeight - BORDER_OVERLAP;
}

/**
 * The live height of one element, for stacking a second sticky layer under
 * the header. `fallback` stands in until the first measurement, and while
 * `ResizeObserver` is missing (happy-dom, older engines).
 */
export function useElementHeight(
  ref: React.RefObject<HTMLElement | null>,
  fallback: number,
): number {
  const [height, setHeight] = useState(fallback);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [ref]);

  return height;
}
