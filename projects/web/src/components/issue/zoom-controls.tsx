import { Button } from "@orz/ui/components/button";
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
} from "@orz/ui/components/dropdown-menu";
import { ChevronDownIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  type ImageLook,
  setImageLook,
  useImageLook,
} from "@/lib/image-look.ts";
import {
  actualAt,
  type Frame,
  fitView,
  isAtMax,
  isAtMin,
  type View,
} from "@/lib/image-zoom.ts";

/**
 * − 100%▾ + for the viewer's title bar (T-537): the readout opens fit, 100%
 * and the background and scaling choices. − and + pause on the zoom stops
 * they cross (T-780).
 */
export function ZoomControls({
  frame,
  view,
  atCentre,
  step,
  imageOptions = true,
}: {
  /** Null while there is nothing to zoom, which disables every control. */
  frame: Frame | null;
  view: View | null;
  atCentre: (op: (f: Frame, v: View, cx: number, cy: number) => View) => void;
  step: (dir: 1 | -1) => void;
  /** The background and scaling choices; a diagram has its own ground and is vector. */
  imageOptions?: boolean;
}) {
  const look = useImageLook();
  const ready = frame !== null && view !== null;
  // − and + give way to pinch on a phone, where the title bar has no room
  // for them beside the filename.
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="zoom out"
        disabled={!ready || isAtMin(frame, view)}
        className="max-sm:hidden"
        onClick={() => step(-1)}
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
          {imageOptions && (
            <>
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
                <DropdownMenuRadioItem value="black">
                  Black
                </DropdownMenuRadioItem>
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
                <DropdownMenuRadioItem value="smooth">
                  Smooth
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="pixelated">
                  Pixelated
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="zoom in"
        disabled={!ready || isAtMax(frame, view)}
        className="max-sm:hidden"
        onClick={() => step(1)}
      >
        <PlusIcon />
      </Button>
    </span>
  );
}
