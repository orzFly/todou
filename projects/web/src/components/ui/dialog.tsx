import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Room left in `delta`'s direction, by the axis the gesture is mostly on. */
function hasScrollRoom(node: Element, horizontal: boolean, delta: number) {
  const style = getComputedStyle(node);
  const overflow = horizontal ? style.overflowX : style.overflowY;
  if (overflow === "visible" || overflow === "hidden" || overflow === "clip")
    return false;
  const travel = horizontal
    ? node.scrollWidth - node.clientWidth
    : node.scrollHeight - node.clientHeight;
  if (travel < 1) return false;
  // A right-to-left box counts scrollLeft down from 0, so the gesture and the
  // position have to pass through the same flip. Correcting only the position
  // asks the question backwards: every branch answers for the other direction.
  const factor = horizontal && style.direction === "rtl" ? -1 : 1;
  const position = factor * (horizontal ? node.scrollLeft : node.scrollTop);
  return factor * delta > 0 ? travel - position >= 1 : position >= 1;
}

/**
 * The modal scroll lock decides whether a gesture would overscroll by walking
 * up from `event.target`, and an open shadow root retargets that to its host —
 * so a scroller *inside* the shadow tree is invisible to it and every gesture
 * over one is cancelled. Scrollers above the host are visible, which is why a
 * dialog's own body already scrolls while pierre's diff does not (T-450).
 *
 * Measured on Chromium 153: over the diff all ten wheels were cancelled and
 * `scrollLeft` never left 0, while a plain `overflow-x: scroll` div added to
 * the same dialog scrolled normally. Room to move is required, in this
 * gesture's own direction, so a scroller at its end still reaches the lock and
 * the page behind the dialog stays where it was.
 */
function releaseShadowScroll(
  event: React.SyntheticEvent<HTMLElement>,
  horizontal: boolean,
  delta: number,
) {
  const target = event.nativeEvent.target;
  const path = event.nativeEvent.composedPath();
  if (path[0] === target) return;
  if (delta === 0) return;
  for (const node of path) {
    // From the host upwards the lock reads the same nodes this loop would.
    if (node === target) return;
    if (node instanceof Element && hasScrollRoom(node, horizontal, delta)) {
      // The lock listens on the document; leaving before the event gets there
      // is what lets the browser scroll this container as it normally would.
      event.stopPropagation();
      return;
    }
  }
}

function releaseShadowWheel(event: React.WheelEvent<HTMLElement>) {
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  releaseShadowScroll(
    event,
    horizontal,
    horizontal ? event.deltaX : event.deltaY,
  );
}

/**
 * The same release for a finger (T-471): one `shouldPrevent` is registered for
 * `wheel` and `touchmove` alike, so a drag reaches the identical dead end.
 *
 * A touchmove carries no delta, and the lock derives one by subtracting the
 * live touch from where the gesture started — not from the previous move. This
 * subtracts the same pair, because the two answers have to match: a
 * move-to-move delta is a few noisy pixels, and a drag it puts on one axis is a
 * drag the lock is judging on the other.
 */
function releaseShadowDrag(
  event: React.TouchEvent<HTMLElement>,
  origin: { x: number; y: number } | null,
) {
  // A second finger is the lock's pinch-zoom case, which it answers before it
  // ever asks about scrollers, so this one leaves too. With the one finger
  // left, `touches[0]` is the same point the lock reads out of
  // `changedTouches`.
  if (origin === null || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const deltaX = origin.x - touch.clientX;
  const deltaY = origin.y - touch.clientY;
  const horizontal = Math.abs(deltaX) > Math.abs(deltaY);
  releaseShadowScroll(event, horizontal, horizontal ? deltaX : deltaY);
}

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  onWheel,
  onTouchStart,
  onTouchMove,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        onWheel={(event) => {
          onWheel?.(event);
          if (!event.isPropagationStopped()) releaseShadowWheel(event);
        }}
        onTouchStart={(event) => {
          onTouchStart?.(event);
          // Rebaselined by a single finger, and never cleared by the others:
          // the lock's `scrollTouchStart` keeps judging across an extra finger,
          // so dropping the origin there left the rest of that gesture with
          // nothing to subtract and no release at all — one finger down, a
          // second tapped and lifted, and the drag it was in the middle of went
          // back to being cancelled until every finger came up (T-490). While
          // the extra finger is down the pinch-zoom branch in
          // `releaseShadowDrag` is what stands the release down.
          if (event.touches.length === 1)
            dragOrigin.current = {
              x: event.touches[0].clientX,
              y: event.touches[0].clientY,
            };
        }}
        onTouchMove={(event) => {
          onTouchMove?.(event);
          if (!event.isPropagationStopped())
            releaseShadowDrag(event, dragOrigin.current);
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
