import { useMemo } from "react";
import { createPortal } from "react-dom";
import type { DiagramView } from "@/components/issue/attachment-viewer.tsx";
import { DiagramDrawing } from "@/components/issue/compare-canvas.tsx";
import { useZoomPan, type Widening } from "@/components/issue/use-zoom-pan.ts";
import { ZoomControls } from "@/components/issue/zoom-controls.tsx";
import { fitScale } from "@/lib/image-zoom.ts";
import { cn } from "@/lib/utils";

/**
 * One mermaid diagram in the attachment viewer (T-773), zoomed and panned as
 * ImageCanvas zooms an image. Mount it keyed by the diagram.
 */
export function DiagramCanvas({
  view: diagram,
  maximized,
  toolbar,
  lastHeight,
  held,
  dialog,
  widening,
}: {
  view: DiagramView;
  maximized: boolean;
  toolbar: HTMLElement | null;
  lastHeight: { current: number | null };
  held: number | null;
  dialog: HTMLElement | null;
  widening: { current: Widening };
}) {
  const { width, height: h } = diagram.size;
  const natural = useMemo(() => ({ w: width, h }), [width, h]);
  const {
    canvasRef,
    frame,
    view,
    fitted,
    dragging,
    height,
    atCentre,
    handlers,
  } = useZoomPan({
    natural,
    maximized,
    lastHeight,
    held,
    dialog,
    widening,
  });

  return (
    <>
      {toolbar !== null &&
        createPortal(
          <ZoomControls
            frame={frame}
            view={view}
            atCentre={atCentre}
            imageOptions={false}
          />,
          toolbar,
        )}
      <div
        ref={canvasRef}
        data-testid="diagram-canvas"
        data-zoom={view === null ? undefined : view.z.toFixed(4)}
        data-fit={frame === null ? undefined : fitScale(frame).toFixed(4)}
        className={cn(
          "relative touch-none overflow-hidden select-none",
          maximized ? "h-full" : "max-h-[75vh] min-h-24",
          fitted
            ? "cursor-zoom-in"
            : dragging
              ? "cursor-grabbing"
              : "cursor-grab",
        )}
        style={height === undefined ? undefined : { height }}
        {...handlers}
      >
        <DiagramDrawing
          svg={diagram.svg}
          style={
            view === null
              ? {}
              : {
                  width,
                  height: h,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                  borderRadius: fitted ? 6 / view.z : 0,
                }
          }
        />
      </div>
    </>
  );
}
