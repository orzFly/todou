import { Button } from "@orz/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@orz/ui/components/tooltip";
import { useSlashShortcut } from "@orz/ui/hooks/use-slash-shortcut";
import { useRouterState } from "@tanstack/react-router";
import { SearchIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { SearchBox } from "@/components/search-box.tsx";

/**
 * The narrow header's search: an icon that expands into a box across the
 * whole row it sits on (T-232).
 *
 * An overlay rather than a row of its own, so the header keeps its height
 * and the page under it does not jump by 40px on every open. It positions
 * against the nearest positioned ancestor, which the shell makes the row —
 * so this works from either row without knowing which one it is in, and the
 * box always opens where the icon was.
 *
 * No focus trap and no `inert` underneath: this is an inline disclosure, not
 * a modal. Tab past the close button and focus leaves the overlay, which
 * closes it, so nothing covered can be reached while it is still covered.
 */
export function SearchToggle({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  useSlashShortcut(() => setOpen(true));

  // Closing from inside (Escape, the close button) unmounts the control that
  // had focus, which would drop it on `<body>`; it goes back to the icon the
  // overlay grew out of. Focus that left on its own is where the reader sent
  // it, and stays there.
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const close = () => {
    refocus.current = true;
    setOpen(false);
  };
  useLayoutEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open]);

  // Following an offer navigates without unmounting the header, and the
  // pointer never left the overlay to blur it. Closed during render rather
  // than from an effect, so the overlay never paints over the page it just
  // moved to.
  const href = useRouterState({ select: (s) => s.location.href });
  const lastHref = useRef(href);
  if (lastHref.current !== href) {
    lastHref.current = href;
    setOpen(false);
  }

  if (!open) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="icon-sm"
            aria-label="Search"
            aria-expanded={false}
            onClick={() => setOpen(true)}
          >
            <SearchIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Search</TooltipContent>
      </Tooltip>
    );
  }

  return (
    // Opaque on purpose: the header is `bg-background/95` over a blur, and
    // anything translucent here lets the covered logo and account chip show
    // through the box. A fieldset because this is a named group of controls
    // rather than a layout box, and only a grouping element may carry the
    // focus handler that closes it.
    <fieldset
      aria-label="Search"
      className="absolute inset-0 z-10 flex items-center gap-2 bg-background px-4"
      // focusout bubbles, so this reads as "focus left the overlay" — no
      // extra tab stop on the container itself.
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setOpen(false);
      }}
    >
      <SearchBox
        slug={slug}
        className="flex-1"
        listAlign="start"
        autoFocus
        onEscape={close}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close search"
            onClick={close}
          >
            <XIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Close search</TooltipContent>
      </Tooltip>
    </fieldset>
  );
}
