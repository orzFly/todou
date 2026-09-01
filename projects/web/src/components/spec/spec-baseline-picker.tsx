import { Link } from "@tanstack/react-router";
import type { SpecVersionInfo } from "@todou/shared";
import { ChevronDownIcon } from "lucide-react";
import {
  MessageText,
  SpecVersionMenuRow,
  VersionChip,
} from "@/components/spec/spec-version-picker.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SpecSearch } from "@/lib/spec-search.ts";

/**
 * Which version the document on screen is read against (T-192).
 *
 * The companion of the version picker: that one says what is being read,
 * this one what it is read against — so it is drawn as the same control at
 * half the size, down to the push message. Whether there *is* a comparison
 * is no longer its business; that moved to the toggle beside it, which is
 * also what unmounts this one entirely when the answer is no (T-200).
 */
export function SpecBaselinePicker({
  slug,
  issueNumber,
  versions,
  version,
  baseline,
  searchFor,
}: {
  slug: string;
  issueNumber: number;
  /** All versions, oldest first, as `SpecInfo` carries them. */
  versions: SpecVersionInfo[];
  /** The version being viewed. */
  version: number;
  /** The baseline in force. Rendered only while comparing, so never null. */
  baseline: number;
  searchFor: (baseline: number) => SpecSearch;
}) {
  const params = { slug, number: String(issueNumber) };
  const earlier = versions
    .filter((v) => v.number < version)
    .sort((a, b) => b.number - a.number);
  const current = versions.find((v) => v.number === baseline);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-full border pr-2 pl-0.5 text-left text-xs hover:border-foreground/50"
        data-linked-trigger
        title={current?.message ?? undefined}
        aria-label={`comparing against v${baseline}, pick another baseline`}
      >
        <VersionChip
          label={`v${baseline}`}
          active={false}
          className="text-center tabular-nums"
        />
        <span
          data-linked-msg="baseline"
          className="hidden min-w-0 max-w-[var(--spec-bmsg-max,8rem)] truncate text-muted-foreground lg:block"
        >
          <MessageText message={current?.message ?? null} />
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      {/* Same width as the version menu: the rows carry the same push
          messages, and halving this one would wrap what that one fits. */}
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[min(26rem,calc(100vw-2rem))]"
      >
        {earlier.map((v) => {
          const active = v.number === baseline;
          return (
            <DropdownMenuItem key={v.number} asChild>
              <Link
                to="/projects/$slug/issues/$number/spec"
                params={params}
                search={searchFor(v.number)}
                aria-current={active ? "true" : undefined}
                className="items-start gap-2 py-1.5"
              >
                <SpecVersionMenuRow
                  version={v.number}
                  message={v.message}
                  author={v.author}
                  createdAt={v.created_at}
                  active={active}
                  ghostChip
                  tag={v.number === version - 1 ? "previous" : undefined}
                />
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
