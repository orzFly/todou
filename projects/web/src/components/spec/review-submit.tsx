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

type LegacySubmit = {
  slug: string;
  issueNumber: number;
  version: number;
  verdict: SpecReviewVerdict;
  body?: string;
  comments: SpecReviewSubmitInput["comments"];
};

function submitComments(
  drafts: SpecReviewDraft[],
): SpecReviewSubmitInput["comments"] {
  return drafts.map((draft) => ({
    anchor: {
      path: draft.anchor.path,
      version: draft.anchor.version,
      ...(draft.anchor.line_start !== null && draft.anchor.line_end !== null
        ? {
            line_start: draft.anchor.line_start,
            line_end: draft.anchor.line_end,
          }
        : {}),
      ...(draft.anchor.col_start !== null && draft.anchor.col_end !== null
        ? {
            col_start: draft.anchor.col_start,
            col_end: draft.anchor.col_end,
          }
        : {}),
    },
    body: draft.body,
  }));
}

/**
 * The atomic review form. Its text and request lifecycle live in the stable
 * spec session; this dialog may disappear without taking either with it.
 */
export function ReviewSubmitDialog({
  slug,
  issueNumber,
  currentVersion,
  drafts,
  summary: controlledSummary,
  open,
  pendingVerdict: controlledPendingVerdict,
  onSummaryChange,
  onClose,
  onSubmit,
  onSubmitted,
}: {
  slug: string;
  issueNumber: number;
  currentVersion: number;
  drafts: SpecReviewDraft[];
  summary?: string;
  open: boolean;
  pendingVerdict?: SpecReviewVerdict | null;
  onSummaryChange?: (summary: string) => void;
  onClose: () => void;
  onSubmit?: (verdict: SpecReviewVerdict) => void;
  /** Compatibility seam for standalone dialog consumers and focused tests. */
  onSubmitted?: () => void;
}) {
  const [localSummary, setLocalSummary] = useState("");
  const [localVerdict, setLocalVerdict] = useState<SpecReviewVerdict | null>(
    null,
  );
  const editor = useRef<MarkdownEditorHandle>(null);
  const refCompletion = useRefCompletion(slug);
  const queryClient = useQueryClient();
  const isPusher = useIsVersionPusher(slug, issueNumber, currentVersion);
  const summary = controlledSummary ?? localSummary;
  const legacySubmit = useMutation({
    mutationFn: (input: LegacySubmit) =>
      api.submitSpecReview(input.slug, input.issueNumber, {
        version: input.version,
        verdict: input.verdict,
        ...(input.body === undefined ? {} : { body: input.body }),
        comments: input.comments,
      }),
    onSuccess: (_result, input) => {
      for (const key of [
        ["spec", input.slug, input.issueNumber],
        ["timeline", input.slug, input.issueNumber],
        ["issue", input.slug, input.issueNumber],
        ["issues", input.slug],
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      setLocalSummary("");
      editor.current?.setValue("");
      setLocalVerdict(null);
      onSubmitted?.();
    },
    onError: (error) => {
      setLocalVerdict(null);
      toast.error(error.message);
    },
  });
  const pendingVerdict =
    controlledPendingVerdict ?? (legacySubmit.isPending ? localVerdict : null);
  const pending = pendingVerdict !== null;
  const saysNothing = summary.trim() === "" && drafts.length === 0;
  const submit = (verdict: SpecReviewVerdict) => {
    if (onSubmit !== undefined) {
      onSubmit(verdict);
      return;
    }
    setLocalVerdict(verdict);
    const body = (
      controlledSummary === undefined
        ? (editor.current?.getValue() ?? localSummary)
        : summary
    ).trim();
    legacySubmit.mutate({
      slug,
      issueNumber,
      version: currentVersion,
      verdict,
      ...(body === "" ? {} : { body }),
      comments: submitComments(drafts),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
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
          initialValue={summary}
          ownerManagedDirty={controlledSummary !== undefined}
          onChange={(value) => {
            setLocalSummary(value);
            onSummaryChange?.(value);
          }}
          placeholder="Summary (markdown, optional)"
          extensions={refCompletion}
        />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || saysNothing}
            title={
              saysNothing
                ? "Write a summary or stage a comment first"
                : undefined
            }
            onClick={() => submit("comment")}
          >
            {pendingVerdict === "comment" ? "Submitting…" : "Comment"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/60 text-red-700 dark:text-red-400"
            disabled={pending || isPusher}
            title={isPusher ? PUSHER_TITLE : undefined}
            onClick={() => submit("request_changes")}
          >
            {pendingVerdict === "request_changes"
              ? "Submitting…"
              : "Request changes"}
          </Button>
          <Button
            size="sm"
            className="bg-green-700 text-white hover:bg-green-800"
            disabled={pending || isPusher}
            title={isPusher ? PUSHER_TITLE : undefined}
            onClick={() => submit("approve")}
          >
            {pendingVerdict === "approve" ? "Submitting…" : "Approve"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
