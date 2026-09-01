import { GitCompareIcon, SlashIcon } from "lucide-react";
import { cn } from "@/lib/utils.ts";

/**
 * Whether the document on screen is read against an earlier version — the
 * one way in and out of comparing (T-200).
 *
 * It sits between the two version triggers because that is what it reads as:
 * `v4 ⎇ v3` is a range, and turning it off strikes the range through and
 * takes the baseline trigger off the row with it.
 */
export function SpecCompareToggle({
  comparing,
  baseline,
  disabledReason,
  onToggle,
}: {
  comparing: boolean;
  /** The baseline in force; null while comparing is off. */
  baseline: number | null;
  /** v1 has nothing behind it. Given means disabled. */
  disabledReason?: string;
  onToggle: () => void;
}) {
  const disabled = disabledReason !== undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={comparing}
      aria-label={
        disabled
          ? `compare — ${disabledReason}`
          : comparing
            ? `comparing against v${baseline}, turn comparing off`
            : "turn comparing on"
      }
      title={
        disabled
          ? undefined
          : comparing
            ? `Comparing against v${baseline} — click to read without comparing`
            : "Turn comparing on"
      }
      onClick={onToggle}
      className={cn(
        // h-7 like every other control in the row, and square: the icon is
        // the whole label, so there is no text to size it from (T-194).
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
        disabled
          ? "border-dashed text-muted-foreground/60"
          : comparing
            ? "cursor-pointer border-foreground"
            : "cursor-pointer text-muted-foreground hover:border-foreground/50 hover:text-foreground",
      )}
    >
      {comparing ? (
        <GitCompareIcon className="size-3.5" />
      ) : (
        <SlashIcon className="size-3.5" />
      )}
    </button>
  );
}
