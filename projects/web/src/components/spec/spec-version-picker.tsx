import { Link } from "@tanstack/react-router";
import type { SpecVersionInfo } from "@todou/shared";
import { CheckIcon, ChevronDownIcon, GitCompareIcon } from "lucide-react";
import { UserChip } from "@/components/shared/user-chip.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils.ts";

const CHIP = "rounded-full border px-2.5 py-0.5 font-mono text-xs";

function VersionChip({ number, active }: { number: number; active: boolean }) {
  return (
    <span
      className={cn(
        CHIP,
        "shrink-0",
        active
          ? // The important group-focus variant holds the chip's text color
            // against DropdownMenuItem's focus:**:text-accent-foreground
            // descendant override: the chip keeps its own filled background,
            // so recoloring only its text crushes the contrast to ~1:1 in
            // every theme (T-191).
            "border-foreground bg-foreground text-background group-focus/dropdown-menu-item:text-background!"
          : "text-muted-foreground",
      )}
    >
      v{number}
    </span>
  );
}

function MessageText({ message }: { message: string | null }) {
  if (message === null) {
    return <span className="text-muted-foreground italic">no message</span>;
  }
  return <>{message}</>;
}

/**
 * Version switcher for the spec page. The push message is the only place a
 * version says what it changed, and it used to live in a `title` tooltip on
 * a pill — here it is the version's headline (T-178).
 */
export function SpecVersionPicker({
  slug,
  issueNumber,
  versions,
  version,
  compare,
  file,
}: {
  slug: string;
  issueNumber: number;
  /** All versions, oldest first, as `SpecInfo` carries them. */
  versions: SpecVersionInfo[];
  /** The version being viewed. */
  version: number;
  /** The baseline of the diff, when the page is in compare mode. */
  compare?: number;
  /** Kept across every switch so the reader stays on the same document. */
  file?: string;
}) {
  const params = { slug, number: String(issueNumber) };
  const comparing = compare !== undefined;
  const current = versions.find((v) => v.number === version);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          // Capped, so a paragraph-long push message cannot wrap the
          // toolbar it sits in; the message truncates instead.
          "flex min-w-0 max-w-80 cursor-pointer items-center gap-2 rounded-full border py-0.5 pr-2 pl-0.5 text-left text-xs hover:border-foreground/50",
          comparing && "border-foreground/50",
        )}
        title={comparing ? undefined : (current?.message ?? undefined)}
        aria-label={
          comparing
            ? `comparing v${compare} to v${version}, switch version`
            : `viewing v${version}, switch version`
        }
      >
        {comparing ? (
          <span className={cn(CHIP, "shrink-0 border-transparent")}>
            diff v{compare}…v{version}
          </span>
        ) : (
          <>
            <VersionChip number={version} active />
            <span className="hidden min-w-0 truncate lg:block">
              <MessageText message={current?.message ?? null} />
            </span>
          </>
        )}
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[60vh] w-[min(26rem,calc(100vw-2rem))]"
      >
        {[...versions].reverse().map((v) => {
          const active = v.number === version && !comparing;
          return (
            <DropdownMenuItem key={v.number} asChild>
              <Link
                to="/projects/$slug/issues/$number/spec"
                params={params}
                search={{ file, v: v.number }}
                aria-current={active ? "true" : undefined}
                className="items-start gap-2 py-1.5"
              >
                <CheckIcon
                  aria-hidden
                  className={cn("mt-0.5 size-3.5", !active && "invisible")}
                />
                <VersionChip number={v.number} active={active} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2">
                    <MessageText message={v.message} />
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <UserChip user={v.author} nameClassName="text-xs" />
                    <span aria-hidden>·</span>
                    <time
                      dateTime={v.created_at}
                      title={v.created_at}
                      className="truncate"
                    >
                      {new Date(v.created_at).toLocaleString()}
                    </time>
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
          );
        })}
        {version > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                to="/projects/$slug/issues/$number/spec"
                params={params}
                search={{ file, v: version, compare: version - 1 }}
                className="gap-2 py-1.5"
              >
                <GitCompareIcon className="size-3.5 text-muted-foreground" />
                diff v{version - 1}…v{version}
              </Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
