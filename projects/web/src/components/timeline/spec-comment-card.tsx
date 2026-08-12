import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SpecCommentComponent } from "@todou/shared";
import { CheckIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { specFilesQuery } from "@/api/spec.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils.ts";

const CONTEXT_LINES = 8;

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
  // Click-to-expand context (#23): fetch the anchored version lazily and
  // widen the quote by a few lines either side, anchored range highlighted.
  const [expanded, setExpanded] = useState(false);
  const context = useQuery({
    ...specFilesQuery(slug, issueNumber, anchor.version),
    enabled: expanded,
  });
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
      <button
        type="button"
        className="block w-full cursor-pointer text-left"
        title={expanded ? "collapse context" : "expand surrounding context"}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded && context.data ? (
          <ExpandedContext
            fileBody={
              context.data.files.find((f) => f.path === anchor.path)?.body
            }
            lineStart={anchor.line_start}
            lineEnd={anchor.line_end}
            quote={anchor.quote}
          />
        ) : (
          <pre className="max-h-40 overflow-auto bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {anchor.quote}
          </pre>
        )}
      </button>
    </div>
  );
}

function ExpandedContext({
  fileBody,
  lineStart,
  lineEnd,
  quote,
}: {
  fileBody: string | undefined;
  lineStart: number;
  lineEnd: number;
  quote: string;
}) {
  if (fileBody === undefined) {
    // The file vanished from that version snapshot (should not happen —
    // anchors are validated) — fall back to the stored quote.
    return (
      <pre className="bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
        {quote}
      </pre>
    );
  }
  const lines = fileBody.split("\n");
  const from = Math.max(1, lineStart - CONTEXT_LINES);
  const to = Math.min(lines.length, lineEnd + CONTEXT_LINES);
  return (
    <div className="max-h-96 overflow-auto bg-background px-3 py-2 font-mono text-xs">
      {lines.slice(from - 1, to).map((line, i) => {
        const number = from + i;
        const anchored = number >= lineStart && number <= lineEnd;
        return (
          <div
            key={number}
            className={cn(
              "flex whitespace-pre-wrap",
              anchored
                ? "bg-amber-500/10 text-foreground"
                : "text-muted-foreground",
            )}
          >
            <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground/50 select-none">
              {number}
            </span>
            <span className="min-w-0 flex-1">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
