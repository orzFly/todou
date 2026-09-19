import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
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
 * The modal scroll lock decides whether a wheel would overscroll by walking up
 * from `event.target`, and an open shadow root retargets that to its host — so
 * a scroller *inside* the shadow tree is invisible to it and every wheel over
 * one is cancelled. Scrollers above the host are visible, which is why a
 * dialog's own body already scrolls while pierre's diff does not (T-450).
 *
 * Measured on Chromium 153: over the diff all ten wheels were cancelled and
 * `scrollLeft` never left 0, while a plain `overflow-x: scroll` div added to
 * the same dialog scrolled normally. Room to move is required, in this
 * gesture's own direction, so a scroller at its end still reaches the lock and
 * the page behind the dialog stays where it was.
 */
function releaseShadowScroll(event: React.WheelEvent<HTMLElement>) {
  const target = event.nativeEvent.target;
  const path = event.nativeEvent.composedPath();
  if (path[0] === target) return;
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  const delta = horizontal ? event.deltaX : event.deltaY;
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
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
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
          if (!event.isPropagationStopped()) releaseShadowScroll(event);
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
