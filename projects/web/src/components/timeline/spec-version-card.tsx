import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SpecPushedPayload } from "@todou/shared";
import {
  BookOpenTextIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCheck2Icon,
  UnfoldHorizontalIcon,
} from "lucide-react";
import { useState } from "react";
import { meQuery } from "@/api/queries.ts";
import {
  specCommentsQuery,
  specQuery,
  specVersionStatsQuery,
} from "@/api/spec.ts";
import { Button } from "@/components/ui/button";
import { diffstatCells, type SpecFileStat } from "@/lib/spec-version-stats.ts";
import { cn } from "@/lib/utils.ts";

const CHANGE_BADGE: Record<
  SpecFileStat["change"],
  { glyph: string; className: string }
> = {
  added: { glyph: "A", className: "bg-green-600/15 text-green-700" },
  modified: { glyph: "M", className: "bg-yellow-500/20 text-yellow-700" },
  removed: { glyph: "D", className: "bg-red-600/15 text-red-700" },
  renamed: { glyph: "R", className: "bg-blue-600/15 text-blue-700" },
};

/**
 * Version card under a spec_pushed event (T-59): the pushed version's file
 * list with git-stats-style changes. Click contract — file name opens that
 * file at that (historical) version, the ± numbers open the per-file diff,
 * the title opens the whole version, ↔ the whole diff. Expanded by
 * default; the chevron collapses to the header line.
 */
export function SpecVersionCard({
  slug,
  issueNumber,
  payload,
}: {
  slug: string;
  issueNumber: number;
  payload: Record<string, unknown>;
}) {
  const parsed = SpecPushedPayload.safeParse(payload);
  if (!parsed.success) return null;
  return (
    <SpecVersionCardBody
      slug={slug}
      issueNumber={issueNumber}
      payload={parsed.data}
    />
  );
}

function SpecVersionCardBody({
  slug,
  issueNumber,
  payload,
}: {
  slug: string;
  issueNumber: number;
  payload: SpecPushedPayload;
}) {
  const [expanded, setExpanded] = useState(true);
  const version = payload.version;
  const params = { slug, number: String(issueNumber) };

  const stats = useQuery(specVersionStatsQuery(slug, issueNumber, payload));
  const byPath = new Map(stats.data?.map((s) => [s.path, s]) ?? []);
  const totals = (stats.data ?? []).reduce(
    (acc, s) => ({ plus: acc.plus + s.plus, minus: acc.minus + s.minus }),
    { plus: 0, minus: 0 },
  );

  // Annotation footprint: review comments anchored at exactly this version.
  const comments = useQuery(specCommentsQuery(slug, issueNumber));
  const anchoredHere =
    comments.data?.items.filter((i) => i.anchor.version === version) ?? [];
  const outdatedHere = anchoredHere.filter((i) => i.outdated);

  // Review call to action (T-103). The card exists because a push happened,
  // so the spec provably exists — no 404 probe to gate here.
  const info = useQuery(specQuery(slug, issueNumber)).data;
  const me = useQuery(meQuery).data;
  const pushedBy = info?.versions.find((v) => v.number === version)?.author.id;
  // The account that pushed a version can never sign it off (the server
  // answers 403), so its own view gets the state without the button.
  const isPusher = me !== undefined && pushedBy === me.id;
  const awaitingReview =
    info?.current_version === version &&
    info.review_status === "unreviewed" &&
    !isPusher;

  // A rename exists only once both snapshots are in hand, and the payload is
  // added/removed all the way down — so the two rows merge into one when the
  // stats land, rather than the event carrying a pairing it cannot make.
  const rows: Array<{
    path: string;
    change: SpecFileStat["change"];
    from?: string;
  }> = stats.data ?? [
    ...payload.added.map((path) => ({ path, change: "added" as const })),
    ...payload.changed.map((path) => ({ path, change: "modified" as const })),
    ...payload.removed.map((path) => ({ path, change: "removed" as const })),
  ];

  return (
    <div className="mt-1 mb-2 ml-7 max-w-xl overflow-hidden rounded-lg border">
      <div
        className={cn(
          "flex items-center gap-2 py-1 pr-1.5 pl-2 text-sm",
          expanded && "border-b bg-muted/40",
        )}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6 text-muted-foreground"
          aria-label={expanded ? "collapse file list" : "expand file list"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </Button>
        <BookOpenTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <Link
          to="/projects/$slug/issues/$number/spec"
          params={params}
          search={{ v: version }}
          className="shrink-0 font-medium hover:underline"
        >
          Spec v{version}
        </Link>
        {payload.message !== null && (
          <span className="truncate text-xs text-muted-foreground">
            {payload.message}
          </span>
        )}
        <span className="ml-auto shrink-0 space-x-1 font-mono text-xs">
          {stats.data ? (
            <>
              {totals.plus > 0 && (
                <span className="font-semibold text-green-600">
                  +{totals.plus}
                </span>
              )}
              {totals.minus > 0 && (
                <span className="font-semibold text-red-600">
                  −{totals.minus}
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">…</span>
          )}
        </span>
        {version > 1 && (
          <Button
            asChild
            size="icon-sm"
            variant="ghost"
            className="size-6 text-muted-foreground"
          >
            <Link
              to="/projects/$slug/issues/$number/spec"
              params={params}
              search={{ v: version, compare: version - 1 }}
              aria-label={`diff v${version - 1} to v${version}`}
              title={`diff v${version - 1}…v${version}`}
            >
              <UnfoldHorizontalIcon className="size-3.5" />
            </Link>
          </Button>
        )}
      </div>

      {expanded && (
        <ul>
          {rows.map((row) => {
            const stat = byPath.get(row.path);
            const badge = CHANGE_BADGE[row.change];
            const removed = row.change === "removed";
            // A deleted file has nothing to open at vN; both its name and
            // numbers lead to the diff. v1 has no diff side at all.
            const diffSearch =
              version > 1
                ? { file: row.path, v: version, compare: version - 1 }
                : undefined;
            const nameSearch = removed
              ? diffSearch
              : { file: row.path, v: version };
            return (
              <li
                key={row.path}
                className="flex items-center gap-2 border-t border-border/60 px-2.5 py-1 text-xs first:border-t-0 hover:bg-muted/40"
              >
                <span
                  className={cn(
                    "inline-flex size-4 shrink-0 items-center justify-center rounded font-bold text-[10px]",
                    badge.className,
                  )}
                >
                  {badge.glyph}
                </span>
                {row.from !== undefined && (
                  <>
                    <span className="truncate font-mono text-muted-foreground">
                      {row.from}
                    </span>
                    <span className="shrink-0 text-muted-foreground">→</span>
                  </>
                )}
                {nameSearch ? (
                  <Link
                    to="/projects/$slug/issues/$number/spec"
                    params={params}
                    search={nameSearch}
                    className={cn(
                      "truncate font-mono hover:underline",
                      removed && "text-muted-foreground line-through",
                    )}
                  >
                    {row.path}
                  </Link>
                ) : (
                  <span
                    className={cn(
                      "truncate font-mono",
                      removed && "text-muted-foreground line-through",
                    )}
                  >
                    {row.path}
                  </span>
                )}
                <span className="ml-auto shrink-0">
                  {stat &&
                    (diffSearch ? (
                      <Link
                        to="/projects/$slug/issues/$number/spec"
                        params={params}
                        search={diffSearch}
                        className="group inline-flex items-center gap-1.5"
                        title={`diff v${version - 1}…v${version} · ${row.path}`}
                      >
                        <StatNumbers stat={stat} />
                        <DiffstatBar stat={stat} />
                      </Link>
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <StatNumbers stat={stat} />
                      </span>
                    ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {expanded && anchoredHere.length > 0 && (
        <div className="flex items-center gap-2 border-t bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground">
          <Link
            to="/projects/$slug/issues/$number/spec"
            params={params}
            search={{ v: version }}
            className="hover:underline"
          >
            {anchoredHere.length} review comment
            {anchoredHere.length === 1 ? "" : "s"} anchored at v{version}
          </Link>
          {outdatedHere.length > 0 && (
            <span className="rounded-full border px-1.5">
              {outdatedHere.length} outdated by later pushes
            </span>
          )}
        </div>
      )}

      {awaitingReview && (
        <ReviewCallToAction params={params} version={version} />
      )}
    </div>
  );
}

/**
 * The review prompt under the newest still-unreviewed version (T-103) —
 * modelled on GitHub's merge box: a tinted footer that outlives the file
 * list's collapse, because the ask is the point of the card. Older
 * versions and settled verdicts never grow one.
 */
function ReviewCallToAction({
  params,
  version,
}: {
  params: { slug: string; number: string };
  version: number;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-amber-500/30 bg-amber-500/10 px-2.5 py-2"
      data-testid="spec-review-cta"
    >
      <p className="min-w-0 flex-1 font-medium text-sm">Awaiting your review</p>
      <Button asChild>
        <Link
          to="/projects/$slug/issues/$number/spec"
          params={params}
          search={{ v: version }}
        >
          <FileCheck2Icon />
          Read &amp; review →
        </Link>
      </Button>
    </div>
  );
}

export function StatNumbers({ stat }: { stat: SpecFileStat }) {
  return (
    <span className="font-mono group-hover:underline">
      {stat.plus > 0 && <span className="text-green-600">+{stat.plus}</span>}
      {stat.plus > 0 && stat.minus > 0 && " "}
      {stat.minus > 0 && <span className="text-red-600">−{stat.minus}</span>}
      {stat.plus === 0 && stat.minus === 0 && (
        <span className="text-muted-foreground">±0</span>
      )}
    </span>
  );
}

export function DiffstatBar({ stat }: { stat: SpecFileStat }) {
  return (
    <span className="inline-flex gap-[1.5px]" aria-hidden>
      {diffstatCells(stat.plus, stat.minus).map((cell, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative cells
          key={i}
          className={cn(
            "size-1.5 rounded-[1.5px]",
            cell === "plus" && "bg-green-600",
            cell === "minus" && "bg-red-600",
            cell === "none" && "bg-border",
          )}
        />
      ))}
    </span>
  );
}
