import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SpecReviewStatus } from "@todou/shared";
import { ArrowDownIcon, BookOpenTextIcon, FileTextIcon } from "lucide-react";
import {
  latestSpecPushQuery,
  specQuery,
  specVersionStatsQuery,
} from "@/api/spec.ts";
import {
  DiffstatBar,
  StatNumbers,
} from "@/components/timeline/spec-version-card.tsx";
import { eventAnchor } from "@/lib/timeline-anchors.ts";
import { cn } from "@/lib/utils.ts";

const STATUS_STYLE: Record<SpecReviewStatus, string> = {
  unreviewed:
    "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  approved:
    "border-green-600/60 bg-green-600/10 text-green-700 dark:text-green-400",
  changes_requested:
    "border-red-500/60 bg-red-500/10 text-red-700 dark:text-red-400",
};

const STATUS_LABEL: Record<SpecReviewStatus, string> = {
  unreviewed: "awaiting review",
  approved: "approved",
  changes_requested: "changes requested",
};

export function SpecStatusBadge({
  status,
  className,
}: {
  status: SpecReviewStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
        STATUS_STYLE[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The lightweight spec entry under the issue body (T-63): one row —
 * version, review state, file count, total ± — whose click anchor-scrolls
 * to the latest spec_pushed event, where the T-59 version card sits
 * expanded. The T-38 anchor machinery does the scrolling/flashing and
 * loads older timeline pages when the push has scrolled out.
 */
export function SpecEntryRow({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const spec = useQuery(specQuery(slug, issueNumber));
  const latest = useQuery(latestSpecPushQuery(slug, issueNumber));
  const stats = useQuery({
    ...specVersionStatsQuery(
      slug,
      issueNumber,
      latest.data?.payload ?? {
        version: 1,
        message: null,
        added: [],
        changed: [],
        removed: [],
      },
    ),
    enabled: latest.data != null,
  });
  if (!spec.data) return null;

  const totals = (stats.data ?? []).reduce(
    (acc, s) => ({ plus: acc.plus + s.plus, minus: acc.minus + s.minus }),
    { plus: 0, minus: 0 },
  );

  return (
    <Link
      to="/projects/$slug/issues/$number"
      params={{ slug, number: String(issueNumber) }}
      hash={latest.data ? eventAnchor(latest.data.eventId) : undefined}
      hashScrollIntoView={false}
      className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-sm text-muted-foreground hover:border-foreground/40 hover:bg-muted/40"
      data-testid="spec-entry"
    >
      <BookOpenTextIcon className="size-4 shrink-0" />
      <span className="font-medium text-foreground">
        Spec v{spec.data.current_version}
      </span>
      <SpecStatusBadge status={spec.data.review_status} />
      <span className="text-xs">
        {spec.data.files.length} file{spec.data.files.length === 1 ? "" : "s"}
      </span>
      {stats.data && (totals.plus > 0 || totals.minus > 0) && (
        <span className="space-x-1 font-mono text-xs">
          {totals.plus > 0 && (
            <span className="text-green-600">+{totals.plus}</span>
          )}
          {totals.minus > 0 && (
            <span className="text-red-600">−{totals.minus}</span>
          )}
        </span>
      )}
      <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs">
        <ArrowDownIcon className="size-3.5" />
        latest push
      </span>
    </Link>
  );
}

/**
 * "Latest spec" sidebar section (T-63): review state and file links with
 * the push's ± stats. Deliberately verdict-free — approving belongs to
 * the review view. Renders nothing while the issue has no spec.
 */
export function SpecSidebarSection({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const spec = useQuery(specQuery(slug, issueNumber));
  const latest = useQuery(latestSpecPushQuery(slug, issueNumber));
  const stats = useQuery({
    ...specVersionStatsQuery(
      slug,
      issueNumber,
      latest.data?.payload ?? {
        version: 1,
        message: null,
        added: [],
        changed: [],
        removed: [],
      },
    ),
    enabled: latest.data != null,
  });
  if (!spec.data) return null;
  const byPath = new Map(stats.data?.map((s) => [s.path, s]) ?? []);
  const params = { slug, number: String(issueNumber) };

  return (
    <section className="space-y-2" data-testid="spec-sidebar">
      <h3 className="text-xs font-medium text-muted-foreground uppercase">
        Latest spec{" "}
        <span className="font-mono normal-case">
          v{spec.data.current_version}
        </span>
      </h3>
      {latest.data ? (
        <Link
          to="/projects/$slug/issues/$number"
          params={params}
          hash={eventAnchor(latest.data.eventId)}
          hashScrollIntoView={false}
          title="jump to the latest push"
        >
          <SpecStatusBadge status={spec.data.review_status} />
        </Link>
      ) : (
        <SpecStatusBadge status={spec.data.review_status} />
      )}
      <ul>
        {spec.data.files.map((file) => {
          const stat = byPath.get(file.path);
          return (
            <li key={file.path}>
              <Link
                to="/projects/$slug/issues/$number/spec"
                params={params}
                search={{ file: file.path }}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted"
              >
                <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{file.path}</span>
                {stat && (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[10.5px]">
                    <StatNumbers stat={stat} />
                    <DiffstatBar stat={stat} />
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      <Link
        to="/projects/$slug/issues/$number/spec"
        params={params}
        className="text-xs text-muted-foreground hover:underline"
      >
        Read &amp; review →
      </Link>
    </section>
  );
}
