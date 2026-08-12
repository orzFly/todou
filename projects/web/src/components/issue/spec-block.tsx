import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  SpecInfo,
  SpecReviewStatus,
  SpecReviewVerdict,
} from "@todou/shared";
import { BookOpenTextIcon, MessageSquarePlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { specFilesQuery, specQuery } from "@/api/spec.ts";
import { DocumentCard } from "@/components/shared/document-card.tsx";
import { Button } from "@/components/ui/button";
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
 * Spec overview between the issue body and the timeline: the current
 * version's documents as embedded cards (#31's DocumentCard — capped
 * height, expand dialog), version, review state, and the door into the
 * full review view.
 */
export function SpecBlock({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const spec = useQuery(specQuery(slug, issueNumber));
  if (!spec.data) return null;
  return (
    <SpecBlockBody slug={slug} issueNumber={issueNumber} spec={spec.data} />
  );
}

function SpecBlockBody({
  slug,
  issueNumber,
  spec,
}: {
  slug: string;
  issueNumber: number;
  spec: SpecInfo;
}) {
  const queryClient = useQueryClient();
  const quickReview = useMutation({
    // The no-annotations fast path; staged inline comments submit from the
    // full spec view instead.
    mutationFn: (verdict: SpecReviewVerdict) =>
      api.submitSpecReview(slug, issueNumber, {
        version: spec.current_version,
        verdict,
        comments: [],
      }),
    onSuccess: (result) => {
      toast.success(
        result.verdict === "approve"
          ? `Approved spec v${result.version}`
          : `Requested changes on spec v${result.version}`,
      );
      for (const key of [
        ["spec", slug, issueNumber],
        ["timeline", slug, issueNumber],
        ["issue", slug, issueNumber],
        ["issues", slug],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <BookOpenTextIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">Spec</span>
        <span className="rounded-full border px-2 py-0.5 font-mono text-xs text-muted-foreground">
          v{spec.current_version}
        </span>
        <SpecStatusBadge status={spec.review_status} />
        {spec.unresolved_comments > 0 && (
          <span className="text-xs text-muted-foreground">
            {spec.unresolved_comments} unresolved comment
            {spec.unresolved_comments === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto" />
        {spec.review_status === "unreviewed" && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="border-red-500/60 text-red-700 dark:text-red-400"
              disabled={quickReview.isPending}
              onClick={() => quickReview.mutate("request_changes")}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              className="bg-green-700 text-white hover:bg-green-800"
              disabled={quickReview.isPending}
              onClick={() => quickReview.mutate("approve")}
            >
              Approve
            </Button>
          </>
        )}
        <Button asChild size="sm" variant="outline">
          <Link
            to="/projects/$slug/issues/$number/spec"
            params={{ slug, number: String(issueNumber) }}
          >
            Read & review
          </Link>
        </Button>
      </div>
      <SpecFileCards slug={slug} issueNumber={issueNumber} spec={spec} />
    </div>
  );
}

function SpecFileCards({
  slug,
  issueNumber,
  spec,
}: {
  slug: string;
  issueNumber: number;
  spec: SpecInfo;
}) {
  const files = useQuery(specFilesQuery(slug, issueNumber));
  if (!files.data) {
    // Bodies still in flight: hold the space with the plain file names so
    // the block never jumps from empty to cards.
    return (
      <ul className="px-3 py-2">
        {spec.files.map((file) => (
          <li
            key={file.path}
            className="px-2 py-1 font-mono text-xs text-muted-foreground"
          >
            {file.path}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="px-3 py-1">
      {files.data.files.map((file) => (
        <DocumentCard
          key={file.path}
          filename={file.path}
          text={file.body}
          slug={slug}
          issueNumber={issueNumber}
          meta={`${(file.size / 1024).toFixed(1)} KB`}
          collapsedClassName="max-h-56"
          headerActions={
            <Button
              asChild
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
            >
              <Link
                to="/projects/$slug/issues/$number/spec"
                params={{ slug, number: String(issueNumber) }}
                search={{ file: file.path }}
                aria-label={`review ${file.path}`}
              >
                <MessageSquarePlusIcon className="size-3.5" />
              </Link>
            </Button>
          }
        />
      ))}
    </div>
  );
}
