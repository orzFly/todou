import { useQuery } from "@tanstack/react-query";
import { can, enumLookup, type SpecInfo } from "@todou/shared";
import { useState } from "react";
import { projectQuery } from "@/api/queries.ts";
import { useWithdrawSpec } from "@/api/spec.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const reviewDisabledReasons = {
  unreviewed: null,
  approved: "This version has already been reviewed and cannot be withdrawn.",
  changes_requested:
    "This version has already been reviewed and cannot be withdrawn.",
  withdrawn: null,
} satisfies Record<SpecInfo["review_status"], string | null>;

type WithdrawalDraft = {
  slug: string;
  issueNumber: number;
  version: number;
  reason: string;
};

export function WithdrawSpec({
  slug,
  issueNumber,
  version,
  spec,
}: {
  slug: string;
  issueNumber: number;
  version: number;
  spec: SpecInfo;
}) {
  const project = useQuery(projectQuery(slug));
  const canWithdraw = can(project.data?.viewer_role ?? null, "spec.withdraw");
  const withdraw = useWithdrawSpec();
  const [draft, setDraft] = useState<WithdrawalDraft | null>(null);
  const reviewDisabledReason = enumLookup(
    reviewDisabledReasons,
    spec.review_status,
    (value) => `Withdrawal is unavailable for review status: ${value}.`,
    "spec review status",
  );
  const eligible =
    canWithdraw &&
    version === spec.current_version &&
    spec.review_status === "unreviewed";
  const stale =
    draft !== null &&
    (draft.slug !== slug ||
      draft.issueNumber !== issueNumber ||
      draft.version !== spec.current_version);
  const alreadyWithdrawn = spec.review_status === "withdrawn";
  const disabledReason = withdraw.isPending
    ? "Withdrawal is being submitted."
    : stale
      ? "This version is no longer current. Your reason has been kept."
      : !canWithdraw
        ? "You no longer have permission to withdraw this spec."
        : (reviewDisabledReason ??
          ((draft?.reason.trim().length ?? 0) > 2000
            ? "The reason must be at most 2000 characters."
            : undefined));

  return (
    <>
      {eligible && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            withdraw.reset();
            setDraft({ slug, issueNumber, version, reason: "" });
          }}
        >
          Withdraw
        </Button>
      )}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !withdraw.isPending) setDraft(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw spec v{draft?.version}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (draft === null || disabledReason !== undefined) return;
              const reason = draft.reason.trim();
              withdraw.mutate(
                {
                  slug: draft.slug,
                  issueNumber: draft.issueNumber,
                  version: draft.version,
                  ...(reason === "" ? {} : { reason }),
                },
                {
                  onSuccess: () => setDraft(null),
                },
              );
            }}
          >
            <Textarea
              aria-label="Reason (optional)"
              placeholder="Reason (optional, up to 2000 characters)"
              maxLength={2000}
              value={draft?.reason ?? ""}
              onChange={(event) => {
                const reason = event.target.value;
                setDraft((current) =>
                  current === null ? null : { ...current, reason },
                );
              }}
            />
            {withdraw.error && <p role="alert">{withdraw.error.message}</p>}
            {!withdraw.isPending && disabledReason && (
              <p role="status">{disabledReason}</p>
            )}
            {!stale && alreadyWithdrawn && (
              <p role="status">
                Already withdrawn. Submitting again keeps the original reason.
              </p>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={withdraw.isPending}
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={disabledReason !== undefined}
              title={disabledReason}
            >
              {withdraw.isPending ? "Withdrawing…" : "Withdraw"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
