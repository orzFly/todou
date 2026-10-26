import { useEffect } from "react";

/**
 * How the visual viewport sits inside the layout viewport, published on
 * `<html>` as `--vv-top` and `--vv-bottom` for the page's sticky edges.
 *
 * An on-screen keyboard shrinks only the visual viewport on iOS Safari (and on
 * Chrome for Android since 108): `innerHeight` keeps its value, so a sticky
 * `bottom: 0` lands behind the keyboard, and dragging the page then pans the
 * visual viewport down the layout one instead of scrolling — the header slides
 * off the top while the composer floats mid-screen (T-585). iOS 26 ignores
 * `interactive-widget=resizes-content`, so the edges have to follow by hand.
 *
 * A pinch zoom moves the visual viewport too, and there the sticky edges have
 * to stay where the page put them: both values are zero unless the scale is 1.
 */
export function visualViewportInsets(): { top: number; bottom: number } {
  const vv = window.visualViewport;
  if (vv == null || Math.abs(vv.scale - 1) > 0.01) return { top: 0, bottom: 0 };
  return {
    top: Math.max(0, vv.offsetTop),
    bottom: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
  };
}

/** Fired on `window` whenever the published chrome offsets change. */
export const VIEWPORT_CHROME_EVENT = "todou:viewport-chrome";

function announce() {
  window.dispatchEvent(new Event(VIEWPORT_CHROME_EVENT));
}

/** Keep `--vv-top` / `--vv-bottom` current; mounted once, by the shell. */
export function useVisualViewportInsets(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (vv == null) return;
    const root = document.documentElement;
    let last = "";
    const publish = () => {
      const { top, bottom } = visualViewportInsets();
      const next = `${top}/${bottom}`;
      if (next === last) return;
      last = next;
      root.style.setProperty("--vv-top", `${top}px`);
      root.style.setProperty("--vv-bottom", `${bottom}px`);
      announce();
    };
    publish();
    vv.addEventListener("resize", publish);
    vv.addEventListener("scroll", publish);
    return () => {
      vv.removeEventListener("resize", publish);
      vv.removeEventListener("scroll", publish);
      root.style.removeProperty("--vv-top");
      root.style.removeProperty("--vv-bottom");
    };
  }, []);
}

/** Input that marks the scrolling which follows as the reader's own. */
const READER_INPUT = ["touchstart", "wheel", "keydown", "pointerdown"];

/** The settling transition's length in styles.css, plus a frame. */
const SETTLE_MS = 170;

/** How long after the reader's last input a scroll still counts as theirs. */
const READER_WINDOW_MS = 600;

/**
 * Slide the shell header away while the reader scrolls down, and back as they
 * scroll up, the way Safari's own toolbar does — published as
 * `--header-hide`, the number of pixels currently out of view. Mounted once,
 * by the shell, and only `enabled` below `sm`, where the header grows a second
 * row on a screen that has the least room for it (T-594).
 * Every layer pinned beneath the header subtracts the same variable, which is
 * what keeps the seam between them shut while it moves.
 *
 * `page` resets it: the header arrives in view on every new page, the same
 * as it would after a full load.
 *
 * Only the reader's own scrolling moves it: a landing at the end of the
 * timeline or an anchor jump is the page placing itself, and arriving to a
 * vanished header would read as a fault. Momentum keeps counting, because
 * each scroll it produces renews the window the touch opened.
 *
 * Once scrolling stops the header settles fully in or fully out, as Safari's
 * does; a header left half-cut reads as broken.
 */
export function useAutoHideHeader(enabled: boolean, page?: string): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `page` only restarts it
  useEffect(() => {
    const header = document.querySelector<HTMLElement>("header");
    if (!enabled || header === null) return;
    const root = document.documentElement;
    const controller = new AbortController();
    const { signal } = controller;
    let hidden = 0;
    let lastY = window.scrollY;
    let readerUntil = Number.NEGATIVE_INFINITY;
    let touching = false;
    let settle: number | undefined;
    let settled: number | undefined;
    // Never while a finger is down: a drag that pauses is not a drag that
    // ended, and snapping under it would yank the header out of its hand.
    const settleSoon = () => {
      window.clearTimeout(settle);
      if (!touching) settle = window.setTimeout(snap, 120);
    };

    const publish = (next: number, animate: boolean) => {
      if (next === hidden) return;
      hidden = next;
      root.toggleAttribute("data-header-settling", animate);
      root.style.setProperty("--header-hide", `${hidden}px`);
    };
    const snap = () => {
      const height = header.offsetHeight;
      // Near the top there is no room to keep it hidden: what it covers is
      // the start of the page itself.
      const out = hidden > height / 2 && window.scrollY > height;
      publish(out ? height : 0, true);
      // After the settling transition in styles.css, not at its start: the
      // scroll insets measure where the header is, and mid-slide it is
      // neither in nor out.
      window.clearTimeout(settled);
      settled = window.setTimeout(announce, SETTLE_MS);
    };
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      const now = performance.now();
      if (now > readerUntil) return;
      readerUntil = now + READER_WINDOW_MS;
      const height = header.offsetHeight;
      // Overscroll at either end bounces `scrollY` past the range; the bounce
      // is not the reader asking for the header.
      const max = root.scrollHeight - window.innerHeight;
      if (y < 0 || y > max) return;
      publish(
        Math.min(height, Math.max(0, hidden + dy), Math.max(0, y)),
        false,
      );
      settleSoon();
    };

    for (const type of READER_INPUT) {
      window.addEventListener(
        type,
        () => {
          readerUntil = performance.now() + READER_WINDOW_MS;
        },
        { capture: true, passive: true, signal },
      );
    }
    const options = { capture: true, passive: true, signal };
    window.addEventListener("touchstart", () => (touching = true), options);
    for (const type of ["touchend", "touchcancel"]) {
      window.addEventListener(
        type,
        () => {
          touching = false;
          settleSoon();
        },
        options,
      );
    }
    window.addEventListener("scroll", onScroll, { passive: true, signal });
    return () => {
      controller.abort();
      window.clearTimeout(settle);
      window.clearTimeout(settled);
      root.style.removeProperty("--header-hide");
      root.removeAttribute("data-header-settling");
      announce();
    };
  }, [enabled, page]);
}
