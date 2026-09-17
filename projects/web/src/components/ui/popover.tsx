import { Popover as PopoverPrimitive } from "radix-ui";
import type * as React from "react";
import { useRef } from "react";
import { cn } from "@/lib/utils";

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverClose({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Close>) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  // Radix's sticky="partial" default keeps the surface glued to an anchor that
  // is leaving the viewport, and lets it follow the anchor out. See
  // DropdownMenuContent, which makes the same trade for the same reason.
  sticky = "always",
  collisionPadding = 8,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const trigger = useRef<HTMLElement | null>(null);
  const interactedOutside = useRef(false);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        sticky={sticky}
        collisionPadding={collisionPadding}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          // The trigger has to be found now, while the popover is open: unlike
          // a menu, a popover's content carries no pointer back to it, and the
          // trigger's aria-controls — the only link there is — is dropped the
          // moment it closes, which is when the restore needs it.
          const content = event.currentTarget;
          trigger.current =
            content instanceof HTMLElement && content.id !== ""
              ? (([...document.querySelectorAll("[aria-controls]")].find(
                  (element) =>
                    element.getAttribute("aria-controls") === content.id,
                ) as HTMLElement | undefined) ?? null)
              : null;
        }}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          // Mirrors the condition Radix's non-modal branch keeps for itself,
          // `event.defaultPrevented` check included, so the restore below can
          // stand aside in exactly the cases Radix would.
          if (!event.defaultPrevented) interactedOutside.current = true;
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const outside = interactedOutside.current;
          interactedOutside.current = false;
          // Every popover here is non-modal, so a click outside reaches what
          // is under it and focus is already wherever the user just put it —
          // a comment box, the next field. Radix deliberately skips its
          // restore then, and taking it over anyway would drag focus back to
          // the trigger and take a phone's keyboard down with it. Falling
          // through rather than preventDefault()ing hands that decision back:
          // Radix suppresses the restore, moving neither focus nor the page.
          if (outside) return;
          const element = trigger.current;
          // Without a trigger to hand the focus to, fall through to Radix's
          // own restore rather than preventDefault() into a focusless document.
          if (element === null) return;
          event.preventDefault();
          // Radix restores focus with a bare focus(), which lets the browser
          // scroll the trigger back into view — obeying the scroll-padding
          // useScrollInsets writes on <html>. Measured on the Edit labels
          // popover as a 300px jump on Escape (T-388).
          element.focus({ preventScroll: true });
        }}
        className={cn(
          // This surface carried no height cap and no inner scroll at all, so
          // a label list longer than the viewport simply ran off it.
          "z-50 max-h-[calc(100dvh-1rem)] w-72 origin-(--radix-popover-content-transform-origin) overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/5 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverClose, PopoverContent, PopoverTrigger };
