import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SpecCommentComponent } from "@todou/shared";
import { CheckIcon, FileTextIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { Button } from "@/components/ui/button";

/**
 * Anchor header of a spec comment in the timeline: file, lines, version,
 * the quoted source, and the resolution affordance. Renders ABOVE the
 * comment body (the anchor is the context the body talks about — GitHub
 * review-comment layout), unlike the questions card that follows it.
 */
export function SpecCommentAnchorCard({
  slug,
  issueNumber,
  commentId,
  component,
  resolvedAt,
  canResolve,
}: {
  slug: string;
  issueNumber: number;
  commentId: number;
  component: SpecCommentComponent;
  resolvedAt: string | null;
  canResolve: boolean;
}) {
  const anchor = component.anchor;
  const queryClient = useQueryClient();
  const resolve = useMutation({
    mutationFn: () => api.resolveSpecComments(slug, issueNumber, [commentId]),
    onSuccess: () => {
      for (const key of [
        ["timeline", slug, issueNumber],
        ["spec", slug, issueNumber],
        ["issue", slug, issueNumber],
        ["issues", slug],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const lines =
    anchor.line_end === anchor.line_start
      ? `L${anchor.line_start}`
      : `L${anchor.line_start}–${anchor.line_end}`;

  return (
    <div className="mb-2 overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <FileTextIcon className="size-3.5 shrink-0" />
        <span className="truncate font-mono">{anchor.path}</span>
        <span className="shrink-0">
          {lines} · v{anchor.version}
        </span>
        {resolvedAt !== null && (
          <span
            className="shrink-0 rounded-full border border-green-600/60 bg-green-600/10 px-1.5 text-green-700 dark:text-green-400"
            title={resolvedAt}
          >
            resolved
          </span>
        )}
        <span className="ml-auto" />
        {resolvedAt === null && canResolve && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-xs"
            disabled={resolve.isPending}
            onClick={() => resolve.mutate()}
          >
            <CheckIcon className="size-3" />
            Resolve
          </Button>
        )}
        <Link
          to="/projects/$slug/issues/$number/spec"
          params={{ slug, number: String(issueNumber) }}
          search={{ file: anchor.path, v: anchor.version }}
          className="shrink-0 hover:underline"
        >
          view in doc →
        </Link>
      </div>
      <pre className="max-h-40 overflow-auto bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
        {anchor.quote}
      </pre>
    </div>
  );
}
