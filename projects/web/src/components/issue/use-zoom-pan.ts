import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  actualAt,
  canvasHeight,
  type Frame,
  fitView,
  isFitted,
  type Pane,
  panBy,
  reframe,
  toggleAt,
  type View,
  wheelFactor,
  zoomAt,
} from "@/lib/image-zoom.ts";

type Point = { x: number; y: number };

/** Movement under this is still a click/tap, not a drag. */
const TAP_SLOP = 4;
export const ZOOM_STEP = 1.25;
/** The restored canvas's height changes (T-551). */
const TWEEN = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** One pane filling the canvas: a single picture. */
export function fillCanvas(width: number, height: number): Pane[] {
  return [{ x: 0, y: 0, width, height }];
}

/** The pane under a canvas point, or the nearest when it falls in a gap. */
function paneAt(panes: Pane[], p: Point): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  panes.forEach((pane, i) => {
    const dx = Math.max(pane.x - p.x, 0, p.x - (pane.x + pane.width));
    const dy = Math.max(pane.y - p.y, 0, p.y - (pane.y + pane.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

type Layout = { width: number; height: number; panes: Pane[] };

/**
 * The zoom and pan of the attachment viewer's canvas (T-535), apart from what
 * it draws: wheel or pinch zooms about the pointer, drag pans, a click toggles
 * fit ↔ actual pixels, and 0 / 1 / + / − work from the keyboard. Every pane
 * the canvas is cut into shows the same view (T-733), so a pointer is read in
 * the pane it is over and the result moves them all. While `held` is set the
 * canvas keeps that height whatever the zoom or image asks for, and moves to
 * its own once it is cleared.
 */
export function useZoomPan({
  natural,
  panes: layoutPanes = fillCanvas,
  maximized,
  lastHeight,
  held,
}: {
  natural: { w: number; h: number } | null;
  /** The panes a canvas of this size is cut into; the frame is the first's. */
  panes?: (width: number, height: number) => Pane[];
  maximized: boolean;
  lastHeight: { current: number | null };
  held: number | null;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [dragging, setDragging] = useState(false);
  // Kept until this image is measured, rather than collapsing to min-h-24
  // while it loads and tweening up from there.
  const [startHeight] = useState(() => lastHeight.current);

  // Every handler reads and writes the geometry here, never the rendered
  // state: one touch frame delivers a pointermove per finger before React
  // re-renders, and the second must build on the first.
  const live = useRef<{
    frame: Frame | null;
    view: View | null;
    layout: Layout | null;
  }>({
    frame: null,
    view: null,
    layout: null,
  });

  const place = useCallback((f: Frame, v: View, l: Layout) => {
    live.current = { frame: f, view: v, layout: l };
    setFrame(f);
    setView(v);
    setLayout(l);
  }, []);

  // The height this view asks for is rendered, and the ResizeObserver
  // reframes the view against every step of the canvas getting there.
  const apply = useCallback((next: View) => {
    if (live.current.frame === null) return;
    live.current.view = next;
    setView(next);
  }, []);

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el === null || natural === null) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      const panes = layoutPanes(width, height);
      const next: Frame = {
        width: panes[0].width,
        height: panes[0].height,
        naturalWidth: natural.w,
        naturalHeight: natural.h,
        upscale: maximized,
      };
      const { frame: prev, view: v } = live.current;
      lastHeight.current = maximized ? null : height;
      place(
        next,
        prev === null || v === null ? fitView(next) : reframe(prev, next, v),
        { width, height, panes },
      );
    };
    measure();
    // Committed before the frame paints: otherwise each frame of a tween
    // would show the canvas at its new height with the view placed for the
    // old one, and the image would shake (T-551).
    const ro = new ResizeObserver(() => flushSync(measure));
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural, maximized, place, lastHeight, layoutPanes]);

  // Canvas point → the point in the pane it is read in.
  const inPane = useCallback((p: Point, pane: number): Point => {
    const box = live.current.layout?.panes[pane];
    return box === undefined ? p : { x: p.x - box.x, y: p.y - box.y };
  }, []);
  const paneUnder = useCallback(
    (p: Point) => paneAt(live.current.layout?.panes ?? [], p),
    [],
  );

  useEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const local = (clientX: number, clientY: number): Point => {
      const r = el.getBoundingClientRect();
      const p = { x: clientX - r.left, y: clientY - r.top };
      return inPane(p, paneUnder(p));
    };
    // React's onWheel is passive, so it cannot stop the page from scrolling
    // or Chrome's ctrl+wheel from zooming the whole page.
    const onWheel = (e: WheelEvent) => {
      const { frame: f, view: v } = live.current;
      if (f === null || v === null) return;
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      apply(
        zoomAt(f, v, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey), p.x, p.y),
      );
    };
    // Safari reports trackpad pinch as gesture events rather than ctrl+wheel.
    let gestureStart = 1;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = live.current.view?.z ?? 1;
    };
    const onGestureChange = (e: Event) => {
      const { frame: f, view: v } = live.current;
      if (f === null || v === null) return;
      e.preventDefault();
      const g = e as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      const p = local(g.clientX, g.clientY);
      apply(zoomAt(f, v, (gestureStart * g.scale) / v.z, p.x, p.y));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [apply, inPane, paneUnder]);

  const atCentre = useCallback(
    (op: (f: Frame, v: View, cx: number, cy: number) => View) => {
      const { frame: f, view: v } = live.current;
      if (f === null || v === null) return;
      apply(op(f, v, f.width / 2, f.height / 2));
    },
    [apply],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/⌘ +/−/0 stay the browser's page zoom.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=")
        atCentre((f, v, x, y) => zoomAt(f, v, ZOOM_STEP, x, y));
      else if (e.key === "-")
        atCentre((f, v, x, y) => zoomAt(f, v, 1 / ZOOM_STEP, x, y));
      else if (e.key === "0") atCentre((f) => fitView(f));
      else if (e.key === "1") atCentre(actualAt);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atCentre]);

  // Pointer bookkeeping: every active pointer's last position, plus where
  // the gesture started so a click can be told apart from a drag. A gesture
  // is read in the pane it started in, so crossing into the next pane
  // mid-drag does not jump by the gap between them.
  const pointers = useRef(new Map<number, Point>());
  const moved = useRef(false);
  const downAt = useRef<Point>({ x: 0, y: 0 });
  const gesturePane = useRef(0);

  const localOf = (e: ReactPointerEvent): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return inPane(
      { x: e.clientX - r.left, y: e.clientY - r.top },
      gesturePane.current,
    );
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      gesturePane.current = paneUnder({
        x: e.clientX - r.left,
        y: e.clientY - r.top,
      });
    }
    const p = localOf(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      moved.current = false;
      downAt.current = p;
    } else {
      // A second finger makes this a pinch, never a tap.
      moved.current = true;
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    const { frame, view } = live.current;
    if (prev === undefined || frame === null || view === null) return;
    const p = localOf(e);
    if (
      !moved.current &&
      Math.hypot(p.x - downAt.current.x, p.y - downAt.current.y) > TAP_SLOP
    ) {
      moved.current = true;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.entries()];
      const other = a[0] === e.pointerId ? b[1] : a[1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(p.x - other.x, p.y - other.y);
      const mid = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
      const shift = { x: (p.x - prev.x) / 2, y: (p.y - prev.y) / 2 };
      const zoomed =
        before > 0 ? zoomAt(frame, view, after / before, mid.x, mid.y) : view;
      apply(panBy(frame, zoomed, shift.x, shift.y));
    } else if (pointers.current.size === 1 && moved.current) {
      if (!isFitted(frame, view)) {
        setDragging(true);
        apply(panBy(frame, view, p.x - prev.x, p.y - prev.y));
      }
    }
    pointers.current.set(e.pointerId, p);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    if (pointers.current.size > 0) return;
    setDragging(false);
    const { frame, view } = live.current;
    if (moved.current || frame === null || view === null) return;
    const p = localOf(e);
    apply(toggleAt(frame, view, p.x, p.y));
  };

  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) setDragging(false);
  };

  const ready = frame !== null && view !== null && layout !== null;
  const fitted = !ready || isFitted(frame, view);
  // Every row of panes grows by what its pane asks for beyond its height
  // now: one row for a single picture or two side by side, two when they
  // are stacked.
  const rows = ready ? new Set(layout.panes.map((p) => p.y)).size : 1;
  const height = maximized
    ? undefined
    : (held ??
      (ready
        ? layout.height + rows * (canvasHeight(frame, view.z) - frame.height)
        : (startHeight ?? undefined)));

  // From the last measured height, which mid-tween is the one on screen.
  // Only between two restored heights at one width: maximize, restore and
  // the first load land at once, and a resized window should not trail.
  const tweened = useRef<{ height: number; width: number | null } | null>(null);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const prev = tweened.current;
    const from = live.current.layout;
    tweened.current =
      height === undefined ? null : { height, width: from?.width ?? null };
    if (el === null) return;
    for (const a of el.getAnimations()) a.cancel();
    if (from === null || prev === null || height === undefined) return;
    if (prev.width !== null && prev.width !== from.width) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // The capped height, not the requested one: a tween to a height past
    // max-h-[75vh] would stop dead at the cap partway through its curve.
    const to = el.clientHeight;
    if (to !== from.height)
      el.animate(
        [{ height: `${from.height}px` }, { height: `${to}px` }],
        TWEEN,
      );
  }, [height]);

  return {
    canvasRef,
    frame,
    view,
    panes: layout?.panes ?? null,
    ready,
    fitted,
    dragging,
    /** The restored canvas's height; undefined leaves it to CSS. */
    height,
    atCentre,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
