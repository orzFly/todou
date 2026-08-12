import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SpecInfo, SpecReviewStatus } from "@todou/shared";
import { BookOpenTextIcon, FileTextIcon } from "lucide-react";
import { specQuery } from "@/api/spec.ts";
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
 * Spec overview between the issue body and the timeline: file list, version,
 * review state, and the door into the full spec view. The file entries stay
 * deliberately plain — #31 is building the generic embedded-document card,
 * and this block adopts it once that lands.
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
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link
            to="/projects/$slug/issues/$number/spec"
            params={{ slug, number: String(issueNumber) }}
          >
            Read & review
          </Link>
        </Button>
      </div>
      <ul className="grid gap-x-4 px-3 py-2 sm:grid-cols-2">
        {spec.files.map((file) => (
          <li key={file.path}>
            <Link
              to="/projects/$slug/issues/$number/spec"
              params={{ slug, number: String(issueNumber) }}
              search={{ file: file.path }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">{file.path}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
                {(file.size / 1024).toFixed(1)} KB
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
