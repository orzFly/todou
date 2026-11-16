import { type ComponentProps, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A native checkbox, styled like the ones already on the settings pages,
 * plus the one state HTML only exposes as a property: `indeterminate`, for
 * a select-all box over a partial selection.
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
    <input
      ref={ref}
      type="checkbox"
      className={cn("size-4 cursor-pointer accent-primary", className)}
      {...props}
    />
  );
}
