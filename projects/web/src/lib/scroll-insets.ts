import { type RefObject, useLayoutEffect, useRef } from "react";

/** Page coordinates of the thing to be revealed. */
export type ScrollBlock = { top: number; height: number };

/** Viewport coordinates of the strip no overlay covers. */
export type UsableViewport = { top: number; height: number };

/**
 * `"auto"` centres a block that fits and tops-aligns one that does not;
 * `"start"` demands the top edge even when the block would fit, which is what
 * a file diff wants — its path header under the toolbar (T-190 §5).
 */
export type RevealMode = "auto" | "start";

/** Gap between an overlay's edge and whatever lands against it. */
const BREATHING_ROOM = 8;

/** Which `scrollIntoView` alignment reveals as much of `block` as it can. */
export function blockFor(
  block: ScrollBlock,
  usable: UsableViewport,
  mode: RevealMode = "auto",
): ScrollLogicalPosition {
  if (mode === "start") return "start";
  // Overlays can leave nothing over — a long draft in the composer takes the
  // strip past zero — and centring in a negative strip aims above its own top.
  if (usable.height <= 0) return "start";
  return block.height <= usable.height ? "center" : "start";
}

/**
 * Where the page comes to rest once `scrollIntoView` has placed `block`.
 * ↑↓ and the counter read this instead of performing the scroll, so the number
 * on screen cannot disagree with where the arrow lands (T-61).
 */
export function restingScrollY(
  block: ScrollBlock,
  usable: UsableViewport,
  mode: RevealMode = "auto",
): number {
  if (blockFor(block, usable, mode) === "start") return block.top - usable.top;
  return block.top + block.height / 2 - (usable.top + usable.height / 2);
}

/** `auto` and anything unparseable both mean "no overlay on that edge". */
function pixelsOf(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read back off `<html>` rather than passed down: the calls that land a target
 * sit deep inside components that know nothing about the page's overlays, and
 * `scroll-padding` is already the value the engine itself obeys.
 */
export function usableViewport(): UsableViewport {
  const style = getComputedStyle(document.documentElement);
  const top = pixelsOf(style.scrollPaddingTop);
  const bottom = pixelsOf(style.scrollPaddingBottom);
  return { top, height: window.innerHeight - top - bottom };
}

/** One-shot highlight; restartable when the same target is revealed again. */
function flash(el: HTMLElement) {
  el.classList.remove("anchor-flash");
  // Reflow so removing+adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add("anchor-flash");
  el.addEventListener(
    "animationend",
    () => el.classList.remove("anchor-flash"),
    { once: true },
  );
}

/**
 * Bring `el` into the strip no overlay covers, and flash it. The one landing
 * out of which every anchor, ↑↓ step and per-file jump is served.
 */
export function revealBlock(
  el: HTMLElement,
  {
    mode = "auto",
    behavior,
    flash: highlight = true,
  }: {
    mode?: RevealMode;
    behavior?: ScrollBehavior;
    flash?: boolean;
  } = {},
): void {
  const rect = el.getBoundingClientRect();
  const block = blockFor(
    { top: rect.top + window.scrollY, height: rect.height },
    usableViewport(),
    mode,
  );
  el.scrollIntoView({ block, behavior });
  if (highlight) flash(el);
}

export type ScrollInsetSources = {
  /** Overlays pinned to the viewport's top edge, beneath the shell header. */
  top?: ReadonlyArray<RefObject<HTMLElement | null>>;
  bottom?: ReadonlyArray<RefObject<HTMLElement | null>>;
};

/**
 * Declare this page's overlays, so every `scrollIntoView` on it lands clear of
 * them.
 *
 * `useLayoutEffect`, not `useEffect`: the timeline anchor scrolls from a
 * passive effect in a child, which runs before any passive effect here, and
 * its one-shot guard never offers a second chance. Layout effects run ahead of
 * the whole passive pass, so the insets are always in place first.
 *
 * The elements are measured directly rather than through `useElementHeight`,
 * whose state holds a fallback for one commit — 56 against a real 93 on a
 * narrow screen, exactly across the frame a hard refresh lands in.
 */
export function useScrollInsets({
  top = [],
  bottom = [],
}: ScrollInsetSources): void {
  const sources = useRef({ top, bottom });
  const remeasure = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const root = document.documentElement;
    const observed = new Set<Element>();
    let observer: ResizeObserver | null = null;

    const watch = (el: Element) => {
      if (observed.has(el)) return;
      observed.add(el);
      observer?.observe(el);
    };
    const measure = () => {
      // The shell header covers every route; making each page declare it again
      // would only give them a way to disagree.
      const shell = document.querySelector<HTMLElement>("header");
      let topInset = BREATHING_ROOM;
      let bottomInset = 0;
      for (const el of [shell, ...sources.current.top.map((r) => r.current)]) {
        if (el === null) continue;
        topInset += el.getBoundingClientRect().height;
        watch(el);
      }
      for (const el of sources.current.bottom.map((r) => r.current)) {
        if (el === null) continue;
        bottomInset += el.getBoundingClientRect().height;
        watch(el);
      }
      root.style.scrollPaddingTop = `${topInset}px`;
      root.style.scrollPaddingBottom = `${bottomInset}px`;
    };

    observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    remeasure.current = measure;
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
      root.style.removeProperty("scroll-padding-top");
      root.style.removeProperty("scroll-padding-bottom");
    };
  }, []);

  // An overlay that mounts later — the spec composer opening, the timeline's
  // own composer arriving with the card — had a null ref when the effect above
  // ran, and nothing observes an element that does not exist yet.
  useLayoutEffect(() => {
    sources.current = { top, bottom };
    remeasure.current();
  });
}
