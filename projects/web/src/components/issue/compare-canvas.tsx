import { ChevronsLeftRightIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type {
  CompareDiagram,
  CompareImage,
  ComparePair,
} from "@/components/issue/attachment-viewer.tsx";
import { CHECKER } from "@/components/issue/image-canvas.tsx";
import {
  releaseWidth,
  useZoomPan,
  type Widening,
} from "@/components/issue/use-zoom-pan.ts";
import { ZoomControls } from "@/components/issue/zoom-controls.tsx";
import {
  CompareLabel,
  CompareModes,
  type CompareSide,
} from "@/components/shared/media-compare.tsx";
import { type CompareMode, useCompareMode } from "@/lib/compare-mode.ts";
import { useImageLook } from "@/lib/image-look.ts";
import { fitScale, type Pane, sideBySidePanes } from "@/lib/image-zoom.ts";
import { cn } from "@/lib/utils";

const GAP = 8;

/** Keys a focused slider answers itself, which must not also page the viewer. */
const SLIDER_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
function keepSliderKeys(e: KeyboardEvent) {
  if (SLIDER_KEYS.has(e.key)) e.stopPropagation();
}

function useWindowHeight() {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

type Hover = { pane: number; x: number; y: number };

/**
 * Two versions of an image in the attachment viewer (T-733), drawn as one
 * view: one zoom and one position for both, from the union of their sizes
 * with their top-left corners together, so wherever either is zoomed or
 * dragged the other follows. Side by side cuts the canvas into two panes
 * showing that same view; the overlay modes stack both in one. Mount it
 * keyed by the pair, as ImageCanvas is by its image. Two versions of a
 * diagram are drawn the same way, always side by side, left and right
 * (T-773).
 */
export function CompareCanvas({
  pair,
  maximized,
  toolbar,
  lastHeight,
  held,
  dialog,
  widening,
  cut,
  onCut,
  fade,
}: {
  pair: ComparePair;
  maximized: boolean;
  toolbar: HTMLElement | null;
  lastHeight: { current: number | null };
  held: number | null;
  dialog: HTMLElement | null;
  widening: { current: Widening };
  /** Swipe's split, in percent of the canvas width. */
  cut: number;
  onCut: (cut: number) => void;
  /** Onion skin's opacity of the after side, in percent. */
  fade: number;
}) {
  const look = useImageLook();
  const diagram = pair.kind === "diagram";
  const stored = useCompareMode();
  // A diagram has no overlay modes, and leaves the page's mode alone.
  const mode = diagram ? "2up" : stored;
  const twoUp = mode === "2up";
  const [failed, setFailed] = useState(false);
  const { before, after } = pair;
  const natural = useMemo(
    () =>
      failed
        ? null
        : {
            w: Math.max(before.size.width, after.size.width),
            h: Math.max(before.size.height, after.size.height),
          },
    [failed, before.size, after.size],
  );
  const windowHeight = useWindowHeight();
  const panes = useCallback(
    (width: number, height: number, rest: number): Pane[] => {
      if (!twoUp || natural === null) return [{ x: 0, y: 0, width, height }];
      // Left and right whatever the shape: the two read against each other,
      // and the viewer is wide enough for it.
      if (diagram) {
        const w = (width - GAP) / 2;
        return [
          { x: 0, y: 0, width: w, height },
          { x: w + GAP, y: 0, width: w, height },
        ];
      }
      // The arrangement is chosen against the tallest the canvas may get
      // and the width it rests at, so it does not flip while a restored
      // canvas grows with the zoom; the panes then split the canvas at the
      // size it has now.
      const cap = maximized ? height : windowHeight * 0.75;
      const { direction } = sideBySidePanes(
        rest,
        cap,
        { width: natural.w, height: natural.h },
        maximized,
        GAP,
      );
      if (direction === "row") {
        const w = (width - GAP) / 2;
        return [
          { x: 0, y: 0, width: w, height },
          { x: w + GAP, y: 0, width: w, height },
        ];
      }
      const h = (height - GAP) / 2;
      return [
        { x: 0, y: 0, width, height: h },
        { x: 0, y: h + GAP, width, height: h },
      ];
    },
    [twoUp, diagram, natural, maximized, windowHeight],
  );
  const zoom = useZoomPan({
    natural,
    panes,
    maximized,
    lastHeight,
    held,
    dialog,
    widening,
  });
  const { frame, view, fitted, dragging, height, handlers } = zoom;

  // Only a mouse has a pointer resting somewhere to mark.
  const [hover, setHover] = useState<Hover | null>(null);
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    handlers.onPointerMove(e);
    if (e.pointerType !== "mouse" || !twoUp || zoom.panes === null) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const pane = zoom.panes.findIndex(
      (p) => x >= p.x && x < p.x + p.width && y >= p.y && y < p.y + p.height,
    );
    const box = zoom.panes[pane];
    setHover(box === undefined ? null : { pane, x: x - box.x, y: y - box.y });
  };

  // Swipe's split stays where it is on screen; only the grip moves it, and a
  // drag anywhere else pans the pictures under it.
  const dragCut = (e: ReactPointerEvent<HTMLElement>) => {
    const canvas = zoom.canvasRef.current;
    if (canvas === null) return;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0) return;
    onCut(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
  };
  const [cutting, setCutting] = useState(false);

  const controls =
    toolbar === null
      ? null
      : createPortal(
          <ZoomControls
            frame={failed ? null : frame}
            view={view}
            atCentre={zoom.atCentre}
            step={zoom.step}
            imageOptions={!diagram}
          />,
          toolbar,
        );

  const onError = () => {
    lastHeight.current = null;
    releaseWidth(dialog, widening);
    setFailed(true);
  };

  // Nothing to measure or zoom: both images as the browser draws them, its
  // broken-image icon and alt text being the error.
  if (failed && pair.kind !== "diagram") {
    return (
      <>
        {controls}
        <div
          data-testid="compare-canvas"
          className="flex flex-col items-center gap-2"
        >
          {[pair.before, pair.after].map((image) => (
            <img
              key={image.src}
              src={image.src}
              alt={`${image.label}: ${image.filename}`}
              className={cn(
                "rounded-md object-contain",
                maximized ? "max-h-[50%]" : "max-h-[37vh]",
              )}
            />
          ))}
        </div>
      </>
    );
  }

  const transform =
    view === null
      ? undefined
      : `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  const imageStyle = (
    image: CompareImage | CompareDiagram,
    round: boolean,
  ): CSSProperties =>
    view === null
      ? {}
      : {
          width: image.size.width,
          height: image.size.height,
          transform,
          borderRadius: round && fitted ? 6 / view.z : 0,
          imageRendering:
            look.smoothing === "pixelated" && view.z > 1
              ? "pixelated"
              : undefined,
        };
  const checker = (size: { width: number; height: number }, round: boolean) =>
    !diagram &&
    look.background === "checker" &&
    view !== null && (
      // In screen pixels like ImageCanvas's, under the picture only.
      <div
        aria-hidden
        className="absolute"
        style={{
          left: view.x,
          top: view.y,
          width: size.width * view.z,
          height: size.height * view.z,
          background: CHECKER,
          borderRadius: round && fitted ? 6 : 0,
        }}
      />
    );
  const image = (side: CompareImage, round: boolean) => (
    <img
      src={side.src}
      alt={`${side.label}: ${side.filename}`}
      draggable={false}
      onError={onError}
      className={cn(
        "absolute top-0 left-0 max-w-none origin-top-left",
        view === null && "invisible",
      )}
      style={imageStyle(side, round)}
    />
  );
  const drawing = (side: CompareDiagram) => (
    <DiagramDrawing svg={side.svg} style={imageStyle(side, true)} />
  );
  const union =
    natural === null ? null : { width: natural.w, height: natural.h };
  const second = twoUp ? zoom.panes?.[1] : undefined;

  return (
    <>
      {controls}
      <div
        ref={zoom.canvasRef}
        data-testid="compare-canvas"
        data-mode={mode}
        data-zoom={view === null ? undefined : view.z.toFixed(4)}
        data-fit={frame === null ? undefined : fitScale(frame).toFixed(4)}
        data-direction={
          second === undefined ? undefined : second.y > 0 ? "column" : "row"
        }
        className={cn(
          "compare-viewer-canvas relative touch-none overflow-hidden select-none",
          ((!diagram && look.background === "black") || mode === "diff") &&
            "bg-black",
          maximized ? "h-full" : "max-h-[75vh] min-h-24",
          fitted
            ? "cursor-zoom-in"
            : dragging
              ? "cursor-grabbing"
              : "cursor-grab",
        )}
        style={
          {
            height,
            "--cut": `${cut}%`,
          } as CSSProperties
        }
        {...handlers}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        {twoUp
          ? (zoom.panes ?? []).map((pane, i) => {
              const which = i === 0 ? "before" : "after";
              return (
                <div
                  key={which}
                  className="compare-viewer-pane"
                  data-side={which}
                  style={{
                    left: pane.x,
                    top: pane.y,
                    width: pane.width,
                    height: pane.height,
                  }}
                >
                  {checker(pair[which].size, true)}
                  {pair.kind === "diagram"
                    ? drawing(pair[which])
                    : image(pair[which], true)}
                  {hover !== null && hover.pane !== i && (
                    <span
                      aria-hidden
                      data-testid="compare-crosshair"
                      className="compare-viewer-crosshair"
                      style={{ left: hover.x, top: hover.y }}
                    />
                  )}
                </div>
              );
            })
          : union !== null &&
            pair.kind !== "diagram" && (
              <div className="compare-viewer-stack">
                {mode !== "diff" && checker(union, false)}
                <div className="compare-viewer-layer" data-side="before">
                  {image(pair.before, false)}
                </div>
                <div
                  className="compare-viewer-layer"
                  data-side="after"
                  style={mode === "onion" ? { opacity: fade / 100 } : undefined}
                >
                  {image(pair.after, false)}
                </div>
              </div>
            )}
        {mode === "swipe" && (
          <div className="media-compare-handle compare-viewer-handle">
            <span
              className="media-compare-grip compare-viewer-grip"
              data-cutting={cutting ? "" : undefined}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                setCutting(true);
              }}
              onPointerMove={(e) => {
                e.stopPropagation();
                if (cutting) dragCut(e);
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                setCutting(false);
              }}
              onPointerCancel={() => setCutting(false)}
            >
              <ChevronsLeftRightIcon className="size-4" />
            </span>
          </div>
        )}
        {mode === "swipe" && (
          <input
            type="range"
            min={0}
            max={100}
            step="any"
            value={cut}
            aria-label={`Swipe between ${before.label} (left) and ${after.label} (right)`}
            onChange={(e) => onCut(Number(e.currentTarget.value))}
            onKeyDown={keepSliderKeys}
            className="compare-viewer-swipe sr-only"
          />
        )}
      </div>
    </>
  );
}

/**
 * A diagram's SVG at its natural size, transformed as an image would be: the
 * browser redraws it as vectors at any zoom (T-773).
 */
export function DiagramDrawing({
  svg,
  style,
}: {
  svg: string;
  style: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "compare-diagram absolute top-0 left-0 origin-top-left overflow-clip",
        style.transform === undefined && "invisible",
      )}
      style={style}
      // mermaid's own output under securityLevel "strict", which runs labels
      // through DOMPurify; the colours added to it are attributes we set.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by mermaid, see above
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function sideOf(image: CompareImage | CompareDiagram): CompareSide {
  return { label: image.label, content: null, size: image.size };
}

/**
 * Under the canvas: the two sides' tags with the modes between them, and
 * onion skin's opacity or difference's key on a second row.
 */
export function CompareBar({
  pair,
  fade,
  onFade,
}: {
  pair: ComparePair;
  fade: number;
  onFade: (fade: number) => void;
}) {
  const stored: CompareMode = useCompareMode();
  const diagram = pair.kind === "diagram";
  const mode = diagram ? "2up" : stored;
  const before = sideOf(pair.before);
  const after = sideOf(pair.after);
  return (
    <div className="compare-viewer-barbox">
      <div
        className="compare-viewer-bar"
        data-mode={mode}
        data-kind={diagram ? "diagram" : undefined}
      >
        <CompareLabel which="before" side={before} other={after} />
        {!diagram && <CompareModes pressed={mode} overlayable />}
        <CompareLabel which="after" side={after} other={before} />
        {mode === "onion" && (
          <div className="compare-viewer-extra">
            <input
              type="range"
              min={0}
              max={100}
              value={fade}
              aria-label={`Opacity of ${after.label}`}
              onChange={(e) => onFade(Number(e.currentTarget.value))}
              onKeyDown={keepSliderKeys}
              className="media-compare-fade"
            />
          </div>
        )}
        {mode === "diff" && (
          <div className="compare-viewer-extra">
            Unchanged pixels are black.
          </div>
        )}
      </div>
    </div>
  );
}
