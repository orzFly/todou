import { useQuery } from "@tanstack/react-query";
import { can, type SpecInfo } from "@todou/shared";
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
  const eligible =
    canWithdraw &&
    version === spec.current_version &&
    spec.review_status === "unreviewed";
  const stale =
    draft !== null &&
    (draft.slug !== slug ||
      draft.issueNumber !== issueNumber ||
      draft.version !== spec.current_version);

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
              if (
                draft === null ||
                withdraw.isPending ||
                stale ||
                !canWithdraw ||
                spec.review_status !== "unreviewed" ||
                draft.reason.trim().length > 2000
              )
                return;
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
            {stale && (
              <p role="status">
                This version is no longer current. Your reason has been kept.
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
              disabled={
                withdraw.isPending ||
                stale ||
                !canWithdraw ||
                spec.review_status !== "unreviewed" ||
                (draft?.reason.trim().length ?? 0) > 2000
              }
            >
              {withdraw.isPending ? "Withdrawing…" : "Withdraw"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
