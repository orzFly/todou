import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatAnchorRange,
  type SpecReviewSubmitInput,
  type SpecReviewVerdict,
  TodouError,
} from "@todou/shared";
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/queries.ts";
import {
  invalidateSpecState,
  specQuery,
  useIsVersionPusher,
  useViewerApprovedCurrentRound,
} from "@/api/spec.ts";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/shared/markdown-editor.tsx";
import {
  type ReviewCompletion,
  useReviewCompletion,
} from "@/components/spec/use-review-completion.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRefCompletion } from "@/lib/editor/ref-completion.ts";
import {
  confirmSubmittedSpecReviewDrafts,
  type SpecReviewDraft,
} from "@/lib/spec-drafts.ts";

const PUSHER_TITLE =
  "You pushed this version — its verdict has to come from someone else";

type LegacySubmit = {
  slug: string;
  issueNumber: number;
  version: number;
  verdict: SpecReviewVerdict;
  body?: string;
  comments: SpecReviewSubmitInput["comments"];
  completion: ReviewCompletion;
  submittedSummary: string;
  submittedDrafts: SpecReviewDraft[];
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
  const localSubmitting = useRef(false);
  const refCompletion = useRefCompletion(slug);
  const queryClient = useQueryClient();
  const beginCompletion = useReviewCompletion(slug, issueNumber);
  const isPusher = useIsVersionPusher(slug, issueNumber, currentVersion);
  const approvedInCurrentRound = useViewerApprovedCurrentRound(
    slug,
    issueNumber,
    currentVersion,
  );
  const spec = useQuery(specQuery(slug, issueNumber)).data;
  const staleVersion =
    spec !== undefined &&
    spec !== null &&
    spec.current_version !== currentVersion;
  const withdrawn = spec?.review_status === "withdrawn";
  const summary = controlledSummary ?? localSummary;
  const latestSummary = useRef(summary);
  latestSummary.current = summary;
  const legacySubmit = useMutation({
    mutationFn: (input: LegacySubmit) =>
      api.submitSpecReview(input.slug, input.issueNumber, {
        version: input.version,
        verdict: input.verdict,
        ...(input.body === undefined ? {} : { body: input.body }),
        comments: input.comments,
      }),
    onSuccess: (result, input) => {
      confirmSubmittedSpecReviewDrafts(
        input.slug,
        input.issueNumber,
        input.submittedDrafts,
      );
      return input.completion.complete(result, () => {
        localSubmitting.current = false;
        if (input.completion.isCurrent()) {
          if (
            (editor.current?.getValue() ?? latestSummary.current) ===
            input.submittedSummary
          ) {
            setLocalSummary("");
            editor.current?.setValue("");
          }
          setLocalVerdict(null);
          onSubmitted?.();
        }
      });
    },
    onError: (error, input) => {
      if (error instanceof TodouError && error.status === 409) {
        void invalidateSpecState(queryClient, input.slug, input.issueNumber);
      }
      setLocalVerdict(null);
      localSubmitting.current = false;
      toast.error(error.message);
    },
  });
  const pendingVerdict =
    controlledPendingVerdict ?? (legacySubmit.isPending ? localVerdict : null);
  const pending = pendingVerdict !== null;
  const saysNothing = summary.trim() === "" && drafts.length === 0;
  // Both responsive forms and the submit guard share these conditions.
  const commentDisabled = pending || staleVersion || saysNothing;
  const verdictDisabled = pending || staleVersion || withdrawn || isPusher;
  const approveDisabled = verdictDisabled || approvedInCurrentRound;
  const staleTitle = `Spec v${currentVersion} is no longer current. Your review draft has been kept.`;
  const verdictTitle = staleVersion
    ? staleTitle
    : withdrawn
      ? "This spec has been withdrawn"
      : isPusher
        ? PUSHER_TITLE
        : undefined;
  const approveTitle =
    verdictTitle ??
    (approvedInCurrentRound
      ? "You already approved this spec in the current review round"
      : undefined);
  const commentTitle = staleVersion
    ? staleTitle
    : saysNothing
      ? "Write a summary or stage a comment first"
      : undefined;
  const submit = (verdict: SpecReviewVerdict) => {
    if (
      verdict === "comment"
        ? commentDisabled
        : verdict === "approve"
          ? approveDisabled
          : verdictDisabled
    )
      return;
    if (onSubmit !== undefined) {
      onSubmit(verdict);
      return;
    }
    if (localSubmitting.current) return;
    localSubmitting.current = true;
    setLocalVerdict(verdict);
    const submittedSummary =
      controlledSummary === undefined
        ? (editor.current?.getValue() ?? localSummary)
        : summary;
    const body = submittedSummary.trim();
    legacySubmit.mutate({
      slug,
      issueNumber,
      version: currentVersion,
      verdict,
      ...(body === "" ? {} : { body }),
      comments: submitComments(drafts),
      completion: beginCompletion(),
      submittedSummary,
      submittedDrafts: drafts.map((draft) => ({
        ...draft,
        anchor: { ...draft.anchor },
      })),
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
        className="grid-cols-1 max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (editor.current?.dismissCompletion() === true) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="min-w-0 text-sm leading-normal font-medium [overflow-wrap:anywhere]">
            Finish review — spec v{currentVersion}
          </DialogTitle>
        </DialogHeader>
        {staleVersion && <p role="status">{staleTitle}</p>}

        {drafts.length > 0 && (
          <ul className="min-w-0 max-h-48 space-y-1 overflow-y-auto text-xs [overflow-wrap:anywhere]">
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
          className="min-h-16 max-h-48"
          initialValue={summary}
          ownerManagedDirty={controlledSummary !== undefined}
          onChange={(value) => {
            setLocalSummary(value);
            onSummaryChange?.(value);
          }}
          placeholder="Summary (markdown, optional)"
          extensions={refCompletion}
        />

        <div className="hidden justify-end gap-2 sm:flex">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={commentDisabled}
            title={commentTitle}
            onClick={() => submit("comment")}
          >
            {pendingVerdict === "comment" ? "Submitting…" : "Comment"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-500/60 text-red-700 dark:text-red-400"
            disabled={verdictDisabled}
            title={verdictTitle}
            onClick={() => submit("request_changes")}
          >
            {pendingVerdict === "request_changes"
              ? "Submitting…"
              : "Request changes"}
          </Button>
          <Button
            size="sm"
            className="bg-green-700 text-white hover:bg-green-800"
            disabled={approveDisabled}
            title={approveTitle}
            onClick={() => submit("approve")}
          >
            {pendingVerdict === "approve" ? "Submitting…" : "Approve"}
          </Button>
        </div>

        <div className="flex min-w-0 justify-end sm:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={pending}>
                {pending ? "Submitting…" : "Submit"}
                <ChevronDownIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-48 max-w-[calc(100vw-1rem)]"
            >
              <DropdownMenuItem
                disabled={commentDisabled}
                title={commentTitle}
                onSelect={() => submit("comment")}
              >
                Comment only
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-red-700 focus:bg-red-50 focus:text-red-700 data-disabled:text-muted-foreground dark:text-red-400 dark:focus:bg-red-950 dark:focus:text-red-400 dark:data-disabled:text-muted-foreground"
                disabled={verdictDisabled}
                title={verdictTitle}
                onSelect={() => submit("request_changes")}
              >
                Request changes
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-green-700 focus:bg-green-50 focus:text-green-700 data-disabled:text-muted-foreground dark:text-green-400 dark:focus:bg-green-950 dark:focus:text-green-400 dark:data-disabled:text-muted-foreground"
                disabled={approveDisabled}
                title={approveTitle}
                onSelect={() => submit("approve")}
              >
                Approve
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </DialogContent>
    </Dialog>
  );
}
