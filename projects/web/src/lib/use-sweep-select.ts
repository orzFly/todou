import { type PointerEvent, useCallback, useEffect, useRef } from "react";

/** Marks the element a sweep may start on: a box, or the label around it. */
export const SWEEP_START = "data-sweep-start";
/** Marks what a sweep paints when the pointer crosses it: a row, a card. */
export const SWEEP_KEY = "data-sweep-key";

// Fine enough that a fast flick across 32px rows still lands in each one,
// coarse enough that a long one stays a handful of hit tests.
const STEP = 8;
const MAX_STEPS = 200;

/**
 * Drag across checkboxes to select (T-772): pressing a box and moving off it
 * paints every row the pointer crosses with the state opposite to the one
 * the first box had — starting on an unchecked box adds, on a checked one
 * removes. A press that never leaves its box stays an ordinary click.
 *
 * Spread the handler on the element that holds every row. Mouse and pen
 * only: on touch the same motion is a scroll.
 */
export function useSweepSelect<K>(sweep: {
  isSelected: (key: K) => boolean;
  paint: (keys: readonly K[], on: boolean) => void;
  parse: (raw: string) => K;
}): { onPointerDownCapture: (event: PointerEvent<HTMLElement>) => void } {
  // Read when the pointer moves, long after the render that handed it in.
  const latest = useRef(sweep);
  useEffect(() => {
    latest.current = sweep;
  });
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDownCapture = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      // Shift-click extends a range and the platform modifiers are someone
      // else's; neither starts a sweep.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const root = event.currentTarget;
      const target = event.target as Element;
      const start = target.closest(`[${SWEEP_START}]`);
      if (!start) return;
      const raw = target.closest(`[${SWEEP_KEY}]`)?.getAttribute(SWEEP_KEY);
      if (raw == null) return;
      stop.current?.();

      const { parse, isSelected } = latest.current;
      const first = parse(raw);
      const on = !isSelected(first);
      const pointerId = event.pointerId;
      const crossed = new Set<string>([raw]);
      let swept = false;
      let x = event.clientX;
      let y = event.clientY;

      const keyAt = (px: number, py: number) => {
        const row = document
          .elementFromPoint(px, py)
          ?.closest(`[${SWEEP_KEY}]`);
        return row && root.contains(row) ? row.getAttribute(SWEEP_KEY) : null;
      };

      const move = (e: globalThis.PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const dx = e.clientX - x;
        const dy = e.clientY - y;
        const steps = Math.min(
          MAX_STEPS,
          Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP)),
        );
        const fresh: string[] = [];
        for (let i = 1; i <= steps; i++) {
          const key = keyAt(x + (dx * i) / steps, y + (dy * i) / steps);
          if (key === null || crossed.has(key)) continue;
          crossed.add(key);
          fresh.push(key);
        }
        x = e.clientX;
        y = e.clientY;
        if (fresh.length === 0) return;
        // The first box joins the sweep only once the pointer leaves it,
        // so a press that stays put is still the box's own click.
        if (!swept) fresh.unshift(raw);
        swept = true;
        window.getSelection()?.removeAllRanges();
        latest.current.paint(fresh.map(latest.current.parse), on);
      };

      // The press began on a box, so any selection it would drag out is
      // across the titles it passes, which nobody meant to copy.
      const noSelect = (e: Event) => e.preventDefault();

      const end = (e: globalThis.PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        stop.current?.();
        // Released back on the first box, the browser still clicks it, which
        // would flip back what the sweep just painted. Released anywhere else
        // the click goes to an ancestor both ends share, which is no box.
        if (!swept || !(e.target instanceof Node && start.contains(e.target)))
          return;
        const swallow = (c: MouseEvent) => {
          c.preventDefault();
          c.stopPropagation();
        };
        window.addEventListener("click", swallow, {
          capture: true,
          once: true,
        });
        // The click follows its pointerup within the same input task; a
        // guard still up after that would eat the next deliberate click.
        setTimeout(
          () => window.removeEventListener("click", swallow, { capture: true }),
          0,
        );
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      document.addEventListener("selectstart", noSelect);
      stop.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        document.removeEventListener("selectstart", noSelect);
        stop.current = null;
      };
    },
    [],
  );

  return { onPointerDownCapture };
}
