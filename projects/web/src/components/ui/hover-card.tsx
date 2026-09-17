import { HoverCard as HoverCardPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function HoverCard({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return (
    <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  className,
  align = "start",
  sideOffset = 4,
  // As PopoverContent and DropdownMenuContent do. Without it the available
  // width runs to the viewport's own edge, which a 448px card then sits flush
  // against on a narrow screen.
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        // `collisionPadding` moves a card, it cannot shrink one, so the fixed
        // `w-[28rem]` needs the cap beside it to survive a 390px viewport;
        // Radix has already deducted the padding from that variable.
        className={cn(
          "z-50 w-[28rem] max-w-(--radix-hover-card-content-available-width) origin-(--radix-hover-card-content-transform-origin) rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg ring-1 ring-foreground/5 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
