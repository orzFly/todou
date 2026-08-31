import type { SpecVersionInfo } from "@todou/shared";
import { ChevronDownIcon, GitCompareIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils.ts";

// min-w sized for `no baseline`, the longest label: a fixed width is what
// keeps the presentation switch beside it from sliding as the baseline
// changes (T-190 rule 2).
const TRIGGER =
  "flex min-w-32 shrink-0 items-center justify-center gap-1.5 rounded-full border py-0.5 pr-2 pl-2.5 text-xs tabular-nums";

/**
 * Which version the document on screen is read against (T-192).
 *
 * The companion of the version picker: that one says what is being read,
 * this one what it is read against. "No baseline" is the plain-reading
 * position the old "changes since vN" toggle used to hold.
 *
 * A filter over the page rather than a destination, so the entries rewrite
 * the search params instead of being links: the off position never reaches
 * the URL at all, which would leave two entries sharing one href.
 */
export function SpecBaselinePicker({
  versions,
  version,
  baseline,
  onChange,
}: {
  /** All versions, oldest first, as `SpecInfo` carries them. */
  versions: SpecVersionInfo[];
  /** The version being viewed. */
  version: number;
  /** The baseline in force, or null while reading without one. */
  baseline: number | null;
  onChange: (baseline: number | null) => void;
}) {
  const earlier = versions
    .map((v) => v.number)
    .filter((n) => n < version)
    .sort((a, b) => b - a);
  const label = baseline === null ? "no baseline" : `vs v${baseline}`;

  if (earlier.length === 0) {
    return (
      // A disabled button answers no pointer events, its own tooltip
      // included, so the reason hangs on a wrapper instead.
      <span title={`v${version} has no earlier version to compare against`}>
        <button
          type="button"
          disabled
          className={cn(TRIGGER, "text-muted-foreground/50")}
        >
          <GitCompareIcon className="size-3.5" />
          {label}
          <ChevronDownIcon className="size-3.5" />
        </button>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          TRIGGER,
          "cursor-pointer hover:border-foreground/50",
          baseline !== null && "border-foreground/50",
        )}
        aria-label={
          baseline === null
            ? "reading without a baseline, pick one to compare against"
            : `comparing against v${baseline}, pick another baseline`
        }
      >
        <GitCompareIcon className="size-3.5 text-muted-foreground" />
        {label}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[min(20rem,calc(100vw-2rem))]"
      >
        <DropdownMenuRadioGroup
          value={baseline === null ? "off" : String(baseline)}
          onValueChange={(value) =>
            onChange(value === "off" ? null : Number(value))
          }
        >
          <DropdownMenuRadioItem value="off">
            no baseline
            <span className="ml-auto text-muted-foreground text-xs">
              read only
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {earlier.map((number) => (
            <DropdownMenuRadioItem key={number} value={String(number)}>
              <span className="font-mono tabular-nums">vs v{number}</span>
              {number === version - 1 && (
                <span className="ml-auto text-muted-foreground text-xs">
                  previous
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
