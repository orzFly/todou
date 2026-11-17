import { CheckIcon, MinusIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A native checkbox drawn by us rather than the browser (T-731): with
 * `accent-color` the browser still paints the unchecked box white, which on a
 * warm light theme is brighter than the card under it. The input stays native
 * so that `indeterminate`, `<label>` clicks and Space carrying `shiftKey`
 * into `onClick` all keep working. `className` lands on the input.
 */
export function Checkbox({
  indeterminate = false,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className="relative inline-grid size-4 shrink-0 place-items-center">
      <input
        ref={ref}
        type="checkbox"
        className={cn(
          "peer size-4 cursor-pointer appearance-none rounded-[4px] border-[1.5px] border-[color:color-mix(in_oklch,var(--foreground)_40%,transparent)] bg-transparent outline-none transition-[opacity,border-color,background-color] duration-150 hover:border-[color:color-mix(in_oklch,var(--foreground)_55%,transparent)] checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40",
          className,
        )}
        {...props}
      />
      {/* A native box can be checked and indeterminate at once; the dash
          wins, as it does where the browser draws the box. */}
      <CheckIcon
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute hidden size-3 text-primary-foreground peer-[:checked:not(:indeterminate)]:block"
      />
      <MinusIcon
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute hidden size-3 text-primary-foreground peer-indeterminate:block"
      />
    </span>
  );
}

// Spelled out in full because Tailwind only generates class names it can
// find whole in the source; a group name spliced in at runtime would match
// no rule.
const SLOT_HOVER = {
  colhead: {
    icon: "group-hover/colhead:opacity-0",
    box: "group-hover/colhead:opacity-100",
  },
  att: {
    icon: "group-hover/att:opacity-0",
    box: "group-hover/att:opacity-100",
  },
  "att-head": {
    icon: "group-hover/att-head:opacity-0",
    box: "group-hover/att-head:opacity-100",
  },
} as const;

/**
 * A checkbox that stands in for an icon in the same 16px cell (T-732): the
 * icon reads as "not selected", and gives way to the box while the pointer is
 * on `hoverGroup`, while the box has keyboard focus, and while it is checked
 * or indeterminate. A disabled slot never trades its icon away.
 */
export function SelectSlot({
  icon,
  hoverGroup,
  className,
  ...props
}: ComponentProps<typeof Checkbox> & {
  icon: ReactNode;
  hoverGroup: keyof typeof SLOT_HOVER;
}) {
  const hover = props.disabled ? undefined : SLOT_HOVER[hoverGroup];
  return (
    <span className="group/slot inline-grid size-4 shrink-0 place-items-center">
      <span
        aria-hidden
        className={cn(
          "inline-grid place-items-center transition-opacity duration-150 [grid-area:1/1] group-has-[:checked]/slot:opacity-0 group-has-[:focus-visible]/slot:opacity-0 group-has-[:indeterminate]/slot:opacity-0",
          hover?.icon,
        )}
      >
        {icon}
      </span>
      <span className="inline-grid [grid-area:1/1]">
        <Checkbox
          className={cn(
            "opacity-0 checked:opacity-100 indeterminate:opacity-100 focus-visible:opacity-100 disabled:opacity-0",
            hover?.box,
            className,
          )}
          {...props}
        />
      </span>
    </span>
  );
}
