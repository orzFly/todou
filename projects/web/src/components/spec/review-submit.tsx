import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatAnchorRange, type SpecReviewVerdict } from "@todou/shared";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
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
import type { SpecReviewDraft } from "@/lib/spec-drafts.ts";

/**
 * The atomic submit at the end of a review: verdict (mandatory), optional
 * summary, and every staged draft, in one POST. On success the drafts are
 * cleared by the caller — nothing of the review lives on the server before
 * this call.
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
  const queryClient = useQueryClient();
  const submit = useMutation({
    mutationFn: (picked: SpecReviewVerdict) =>
      api.submitSpecReview(slug, issueNumber, {
        version: currentVersion,
        verdict: picked,
        ...(summary.trim() === "" ? {} : { body: summary }),
        comments: drafts.map((d) => ({
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
        })),
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
      <DialogContent className="sm:max-w-lg">
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
            ? "No staged comments — submitting a verdict only."
            : `${drafts.length} staged comment(s) will be posted with the verdict.`}
        </p>

        <MarkdownEditor
          ref={editor}
          ariaLabel="Review summary"
          className="min-h-16"
          onChange={setSummary}
          placeholder="Summary (markdown, optional)"
        />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/60 text-red-700 dark:text-red-400"
            disabled={submit.isPending}
            onClick={() => {
              setVerdict("request_changes");
              submit.mutate("request_changes");
            }}
          >
            {submit.isPending && verdict === "request_changes"
              ? "Submitting…"
              : "Request changes"}
          </Button>
          <Button
            size="sm"
            className="bg-green-700 text-white hover:bg-green-800"
            disabled={submit.isPending}
            onClick={() => {
              setVerdict("approve");
              submit.mutate("approve");
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
