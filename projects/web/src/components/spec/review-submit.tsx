import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  formatAnchorRange,
  type SpecReviewSubmitInput,
  type SpecReviewVerdict,
} from "@todou/shared";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import { useIsVersionPusher } from "@/api/spec.ts";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRefCompletion } from "@/lib/editor/ref-completion.ts";
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";

const PUSHER_TITLE =
  "You pushed this version — its verdict has to come from someone else";

/**
 * Everything the submit needs, handed to `mutate()`: targets and payload
 * ride in the variables so a paused write that outlives the dialog reads
 * the values from the moment of the click, not from whatever the closures
 * hold when it resumes.
 */
type SubmitVars = {
  slug: string;
  issueNumber: number;
  version: number;
  verdict: SpecReviewVerdict;
  body?: string;
  comments: SpecReviewSubmitInput["comments"];
};

/**
 * Pure over its inputs: maps the staged drafts into the request shape. Read
 * at the `mutate()` call so a paused write carries the payload with it,
 * rather than mapping `drafts` again when it resumes.
 */
function submitComments(
  drafts: SpecReviewDraft[],
): SpecReviewSubmitInput["comments"] {
  return drafts.map((d) => ({
    // Strict input schema: file-level anchors OMIT the line keys
    // rather than sending nulls (T-61).
    anchor: {
      path: d.anchor.path,
      version: d.anchor.version,
      ...(d.anchor.line_start !== null && d.anchor.line_end !== null
        ? {
            line_start: d.anchor.line_start,
            line_end: d.anchor.line_end,
          }
        : {}),
      // Columns follow the same omit-rather-than-null rule (T-142).
      ...(d.anchor.col_start !== null && d.anchor.col_end !== null
        ? { col_start: d.anchor.col_start, col_end: d.anchor.col_end }
        : {}),
    },
    body: d.body,
  }));
}

/** Empty means absent — the request omits the key rather than sending "". */
function summaryOf(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The atomic submit at the end of a review: verdict (mandatory), optional
 * summary, and every staged draft, in one POST. On success the drafts are
 * cleared by the caller — nothing of the review lives on the server before
 * this call.
 *
 * Three buttons rather than two (T-277): `comment` says its piece without
 * judging, and is the only one the pusher of this version may submit.
 */
export function ReviewSubmitDialog({
  slug,
  issueNumber,
  currentVersion,
  drafts,
  open,
  onClose,
  onSubmitted,
}: {
  slug: string;
  issueNumber: number;
  currentVersion: number;
  drafts: SpecReviewDraft[];
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [verdict, setVerdict] = useState<SpecReviewVerdict | null>(null);
  const [summary, setSummary] = useState("");
  const editor = useRef<MarkdownEditorHandle>(null);
  const refCompletion = useRefCompletion(slug);
  const queryClient = useQueryClient();
  const isPusher = useIsVersionPusher(slug, issueNumber, currentVersion);
  // The same rule the server enforces: a round that judges nothing has to
  // say something instead.
  const saysNothing = summary.trim() === "" && drafts.length === 0;
  const submit = useMutation({
    mutationFn: (vars: SubmitVars) =>
      api.submitSpecReview(vars.slug, vars.issueNumber, {
        version: vars.version,
        verdict: vars.verdict,
        ...(vars.body === undefined ? {} : { body: vars.body }),
        comments: vars.comments,
      }),
    onSuccess: (result, vars) => {
      toast.success(
        `${
          {
            approve: "Approved",
            request_changes: "Requested changes on",
            comment: "Commented on",
          }[result.verdict]
        } spec v${result.version}`,
      );
      for (const key of [
        ["spec", vars.slug, vars.issueNumber],
        ["timeline", vars.slug, vars.issueNumber],
        ["issue", vars.slug, vars.issueNumber],
        ["issues", vars.slug],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      setSummary("");
      editor.current?.setValue("");
      setVerdict(null);
      onSubmitted();
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        // The first Escape belongs to the completion panel; without this the
        // dialog closes underneath it and takes the summary draft along.
        // Radix reads this key on the document in the capture phase, so the
        // editor never gets a chance at it and the closing happens here.
        onEscapeKeyDown={(event) => {
          if (editor.current?.dismissCompletion() === true) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">
            Finish review — spec v{currentVersion}
          </DialogTitle>
        </DialogHeader>

        {drafts.length > 0 && (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {drafts.map((draft) => (
              <li key={draft.id} className="rounded border px-2 py-1">
                <span className="font-mono">
                  {draft.anchor.path}
                  {draft.anchor.line_start !== null &&
                    ` ${formatAnchorRange(draft.anchor)}`}{" "}
                  (v{draft.anchor.version}
                  {draft.anchor.line_start === null && ", file"})
                </span>{" "}
                <span className="text-muted-foreground">
                  {draft.body.split("\n")[0]}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {drafts.length === 0
            ? "No staged comments — this review carries the summary only."
            : `${drafts.length} staged comment(s) will be posted with this review.`}
        </p>

        <MarkdownEditor
          ref={editor}
          ariaLabel="Review summary"
          className="min-h-16"
          onChange={setSummary}
          placeholder="Summary (markdown, optional)"
          extensions={refCompletion}
        />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {/* Neutral, no red or green: visually it has to read as "no
              stance taken", which is exactly what it submits. */}
          <Button
            size="sm"
            variant="outline"
            disabled={submit.isPending || saysNothing}
            title={
              saysNothing
                ? "Write a summary or stage a comment first"
                : undefined
            }
            onClick={() => {
              const body = summaryOf(editor.current?.getValue() ?? "");
              setVerdict("comment");
              submit.mutate({
                slug,
                issueNumber,
                version: currentVersion,
                verdict: "comment",
                ...(body === undefined ? {} : { body }),
                comments: submitComments(drafts),
              });
            }}
          >
            {submit.isPending && verdict === "comment"
              ? "Submitting…"
              : "Comment"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/60 text-red-700 dark:text-red-400"
            disabled={submit.isPending || isPusher}
            title={isPusher ? PUSHER_TITLE : undefined}
            onClick={() => {
              const body = summaryOf(editor.current?.getValue() ?? "");
              setVerdict("request_changes");
              submit.mutate({
                slug,
                issueNumber,
                version: currentVersion,
                verdict: "request_changes",
                ...(body === undefined ? {} : { body }),
                comments: submitComments(drafts),
              });
            }}
          >
            {submit.isPending && verdict === "request_changes"
              ? "Submitting…"
              : "Request changes"}
          </Button>
          <Button
            size="sm"
            className="bg-green-700 text-white hover:bg-green-800"
            disabled={submit.isPending || isPusher}
            title={isPusher ? PUSHER_TITLE : undefined}
            onClick={() => {
              const body = summaryOf(editor.current?.getValue() ?? "");
              setVerdict("approve");
              submit.mutate({
                slug,
                issueNumber,
                version: currentVersion,
                verdict: "approve",
                ...(body === undefined ? {} : { body }),
                comments: submitComments(drafts),
              });
            }}
          >
            {submit.isPending && verdict === "approve"
              ? "Submitting…"
              : "Approve"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
