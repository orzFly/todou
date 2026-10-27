import { type RefObject, useEffect, useRef, useState } from "react";

const INPUTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Keep what the reader is looking at in place while the timeline fills in
 * above it (T-602).
 *
 * The timeline's own scroll anchoring is off (see `Timeline`), and a fill
 * grows the list above the reader twice over: once as each unit replaces its
 * placeholder, and again moments later as its code blocks swap their plain
 * text for the highlighted view. Until the reader's first input the page's
 * hold owns the viewport, so this only starts then; it ends at the first input
 * after the fill completes, the late resizes having had their chance.
 */
export function useKeepReading(
  listRef: RefObject<HTMLElement | null>,
  filling: boolean,
): void {
  const [active, setActive] = useState(false);
  const started = useRef(false);
  if (filling && !started.current) {
    started.current = true;
    setActive(true);
  }
  const fillingRef = useRef(filling);
  fillingRef.current = filling;

  useEffect(() => {
    const list = listRef.current;
    if (!active || !list || typeof ResizeObserver === "undefined") return;
    let touched = false;
    let anchor: { el: Element; top: number } | null = null;
    // The first unit still showing below the shell's header and any other
    // overlay pinned to the top, which `useScrollInsets` publishes here.
    const pick = () => {
      if (!touched) return;
      const inset =
        Number.parseFloat(
          getComputedStyle(document.documentElement).scrollPaddingTop,
        ) || 0;
      const el = [...list.children].find(
        (child) => child.getBoundingClientRect().bottom > inset,
      );
      anchor = el ? { el, top: el.getBoundingClientRect().top } : null;
    };
    const onInput = () => {
      if (!fillingRef.current && touched) {
        setActive(false);
        return;
      }
      touched = true;
    };
    const observer = new ResizeObserver(() => {
      if (!anchor?.el.isConnected) return;
      const delta = anchor.el.getBoundingClientRect().top - anchor.top;
      if (delta !== 0) window.scrollBy(0, delta);
    });
    observer.observe(list);
    const controller = new AbortController();
    for (const type of INPUTS) {
      window.addEventListener(type, onInput, {
        capture: true,
        passive: true,
        signal: controller.signal,
      });
    }
    window.addEventListener("scroll", pick, {
      passive: true,
      signal: controller.signal,
    });
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [active, listRef]);
}
