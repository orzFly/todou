import { ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  type ImageLook,
  setImageLook,
  useImageLook,
} from "@/lib/image-look.ts";
import {
  actualAt,
  canvasHeight,
  type Frame,
  fitScale,
  fitView,
  isAtMax,
  isAtMin,
  isFitted,
  panBy,
  reframe,
  toggleAt,
  type View,
  wheelFactor,
  zoomAt,
} from "@/lib/image-zoom.ts";
import { cn } from "@/lib/utils";

type Point = { x: number; y: number };

// In screen pixels, never scaled with the image: at 800% a scaled checker
// would be squares bigger than the pixels it is meant to show through.
const CHECKER =
  "repeating-conic-gradient(#d4d4d4 0 25%, #fff 0 50%) 0 0 / 16px 16px";

/** Movement under this is still a click/tap, not a drag. */
const TAP_SLOP = 4;
const STEP = 1.25;
/** The restored canvas's height changes (T-551). */
const TWEEN = { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/**
 * The attachment viewer's image (T-535): wheel or pinch zooms about the
 * pointer, drag pans, a click toggles fit ↔ actual pixels, and − 100%▾ +
 * sit in the viewer's title bar, the readout opening fit, 100% and the
 * background and scaling choices (T-537). Mount it keyed by the image URL
 * so paging starts every image at fit; `lastHeight` carries the canvas
 * height across that remount, so the next image tweens from it.
 */
export function ImageCanvas({
  src,
  alt,
  maximized,
  toolbar,
  lastHeight,
}: {
  src: string;
  alt: string;
  maximized: boolean;
  toolbar: HTMLElement | null;
  lastHeight: { current: number | null };
}) {
  const look = useImageLook();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  // Kept until this image is measured, rather than collapsing to min-h-24
  // while it loads and tweening up from there.
  const [startHeight] = useState(() => lastHeight.current);

  // Every handler reads and writes the geometry here, never the rendered
  // state: one touch frame delivers a pointermove per finger before React
  // re-renders, and the second must build on the first.
  const live = useRef<{ frame: Frame | null; view: View | null }>({
    frame: null,
    view: null,
  });

  const place = useCallback((f: Frame, v: View) => {
    live.current = { frame: f, view: v };
    setFrame(f);
    setView(v);
  }, []);

  // While the pointer is over − 100%▾ +, the canvas keeps the height it had
  // when the pointer arrived: the dialog is centred, so growing would slide
  // the title bar out from under the pointer, and the next click on + would
  // land on the image and toggle back to fit (T-548).
  const heldRef = useRef<number | null>(null);
  const [heldZ, setHeldZ] = useState<number | null>(null);

  // The height this view asks for is rendered, and the ResizeObserver
  // reframes the view against every step of the canvas getting there.
  const apply = useCallback((next: View) => {
    if (live.current.frame === null) return;
    live.current.view = next;
    setView(next);
  }, []);

  const hold = (z: number | null) => {
    heldRef.current = z;
    setHeldZ(z);
  };

  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el === null || natural === null) return;
    const measure = () => {
      const next: Frame = {
        width: el.clientWidth,
        height: el.clientHeight,
        naturalWidth: natural.w,
        naturalHeight: natural.h,
        upscale: maximized,
      };
      const { frame: prev, view: v } = live.current;
      lastHeight.current = maximized ? null : next.height;
      place(
        next,
        prev === null || v === null ? fitView(next) : reframe(prev, next, v),
      );
    };
    measure();
    // Committed before the frame paints: otherwise each frame of a tween
    // would show the canvas at its new height with the view placed for the
    // old one, and the image would shake (T-551).
    const ro = new ResizeObserver(() => flushSync(measure));
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural, maximized, place, lastHeight]);

  useEffect(() => {
    const el = canvasRef.current;
    if (el === null) return;
    const local = (clientX: number, clientY: number): Point => {
      const r = el.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
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
  }, [apply]);

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
        atCentre((f, v, x, y) => zoomAt(f, v, STEP, x, y));
      else if (e.key === "-")
        atCentre((f, v, x, y) => zoomAt(f, v, 1 / STEP, x, y));
      else if (e.key === "0") atCentre((f) => fitView(f));
      else if (e.key === "1") atCentre(actualAt);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atCentre]);

  // Pointer bookkeeping: every active pointer's last position, plus where
  // the gesture started so a click can be told apart from a drag.
  const pointers = useRef(new Map<number, Point>());
  const moved = useRef(false);
  const downAt = useRef<Point>({ x: 0, y: 0 });

  const localOf = (e: ReactPointerEvent): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
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

  const ready = frame !== null && view !== null;
  const fitted = !ready || isFitted(frame, view);
  const height = maximized
    ? undefined
    : ready
      ? canvasHeight(frame, heldZ ?? view.z)
      : (startHeight ?? undefined);

  // From the last measured height, which mid-tween is the one on screen.
  // Only between two restored heights at one width: maximize, restore and
  // the first load land at once, and a resized window should not trail.
  const tweened = useRef<{ height: number; width: number | null } | null>(null);
  useLayoutEffect(() => {
    const el = canvasRef.current;
    const prev = tweened.current;
    const from = live.current.frame;
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

  // − and + give way to pinch on a phone, where the title bar has no room
  // for them beside the filename.
  const controls = (
    <span
      className="inline-flex shrink-0 items-center gap-0.5"
      onPointerEnter={(e) => {
        // Not when arriving on the menu's items: they are portalled out of
        // the span but stay its React children, so React reports entering
        // them as entering the span, and choosing Fit or 100% would be held.
        if (
          e.pointerType === "mouse" &&
          e.currentTarget.contains(e.target as Node)
        )
          hold(live.current.view?.z ?? null);
      }}
      onPointerLeave={() => {
        if (heldRef.current !== null) hold(null);
      }}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="zoom out"
        disabled={!ready || isAtMin(frame, view)}
        className="max-sm:hidden"
        onClick={() => atCentre((f, v, x, y) => zoomAt(f, v, 1 / STEP, x, y))}
      >
        <MinusIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!ready}
            aria-label="zoom and display options"
            className="min-w-12 font-normal text-muted-foreground tabular-nums"
          >
            {ready ? `${Math.round(view.z * 100)}%` : "–"}
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => atCentre((f) => fitView(f))}>
            Fit
            <DropdownMenuShortcut className="pointer-coarse:hidden">
              0
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => atCentre(actualAt)}>
            100%
            <DropdownMenuShortcut className="pointer-coarse:hidden">
              1
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Background
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={look.background}
            onValueChange={(v) =>
              setImageLook({ background: v as ImageLook["background"] })
            }
          >
            <DropdownMenuRadioItem value="black">Black</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="checker">
              Checkerboard
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Scaling
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={look.smoothing}
            onValueChange={(v) =>
              setImageLook({ smoothing: v as ImageLook["smoothing"] })
            }
          >
            <DropdownMenuRadioItem value="smooth">Smooth</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="pixelated">
              Pixelated
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="zoom in"
        disabled={!ready || isAtMax(frame, view)}
        className="max-sm:hidden"
        onClick={() => atCentre((f, v, x, y) => zoomAt(f, v, STEP, x, y))}
      >
        <PlusIcon />
      </Button>
    </span>
  );

  // Nothing to measure or zoom; the static image is what the viewer showed
  // before T-535, and its alt text and broken-image icon are the error.
  if (failed) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn(
          "mx-auto rounded-md object-contain",
          maximized ? "h-full" : "max-h-[75vh]",
        )}
      />
    );
  }

  return (
    <>
      {toolbar !== null && createPortal(controls, toolbar)}
      <div
        ref={canvasRef}
        data-testid="image-canvas"
        data-zoom={view === null ? undefined : view.z.toFixed(4)}
        data-fit={frame === null ? undefined : fitScale(frame).toFixed(4)}
        className={cn(
          "relative touch-none overflow-hidden select-none",
          look.background === "black" && "bg-black",
          maximized ? "h-full" : "max-h-[75vh] min-h-24",
          fitted
            ? "cursor-zoom-in"
            : dragging
              ? "cursor-grabbing"
              : "cursor-grab",
        )}
        style={height === undefined ? undefined : { height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        {look.background === "checker" && natural !== null && view !== null && (
          // Under the image only, so the letterbox still shows where the
          // image ends; black, by contrast, fills the canvas.
          <div
            aria-hidden
            data-testid="image-checker"
            className="absolute"
            style={{
              left: view.x,
              top: view.y,
              width: natural.w * view.z,
              height: natural.h * view.z,
              background: CHECKER,
              borderRadius: fitted ? 6 : 0,
            }}
          />
        )}
        <img
          src={src}
          alt={alt}
          draggable={false}
          onError={() => {
            lastHeight.current = null;
            setFailed(true);
          }}
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          className={cn(
            "absolute top-0 left-0 max-w-none origin-top-left",
            view === null && "invisible",
          )}
          style={
            natural === null || view === null
              ? undefined
              : {
                  width: natural.w,
                  height: natural.h,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                  // The old static image's rounded-md, divided back out of
                  // the scale; zoomed in, a rounded corner would read as the
                  // image's own edge.
                  borderRadius: fitted ? 6 / view.z : 0,
                  // Shrunk, nearest-neighbour drops whole rows and columns;
                  // pixelated only means something once an image pixel is
                  // bigger than a screen pixel.
                  imageRendering:
                    look.smoothing === "pixelated" && view.z > 1
                      ? "pixelated"
                      : undefined,
                }
          }
        />
      </div>
    </>
  );
}
