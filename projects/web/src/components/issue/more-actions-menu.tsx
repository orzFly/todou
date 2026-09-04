import { useNavigate } from "@tanstack/react-router";
import { formatRef, type Issue } from "@todou/shared";
import { EllipsisIcon, FolderInputIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { useDeleteIssueMutation } from "@/api/issues.ts";
import { useRefPrefix } from "@/api/references.ts";
import { MoveIssueDialog } from "@/components/issue/move-issue-dialog.tsx";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The sidebar's overflow menu (T-248), holding what acts on the card as a
 * whole rather than on one of its fields.
 *
 * Both entries open a dialog, so neither is navigation and neither needs an
 * `href`. An entry that did take the reader somewhere would have to be
 * `<DropdownMenuItem asChild><Link …>`, per AGENTS.md.
 */
export function IssueMoreActions({
  slug,
  issue,
}: {
  slug: string;
  issue: Issue;
}) {
  const navigate = useNavigate();
  const refPrefix = useRefPrefix(slug);
  const deleteIssue = useDeleteIssueMutation(slug);
  const [moving, setMoving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  // Radix hands focus back to whatever opened the dialog, and that is a menu
  // item which no longer exists — so it lands on <body> and Tab restarts at
  // the top of the page. The frame is what puts this after radix's own
  // restore; focusing synchronously here is overridden by it.
  const returnFocus = (open: boolean) => {
    if (!open) requestAnimationFrame(() => trigger.current?.focus());
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground uppercase">
          More actions
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              variant="ghost"
              size="icon-sm"
              aria-label="More actions"
            >
              <EllipsisIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          {/* The entries need far more room than the trigger's width, which is
              what the menu defaults to and which here is a 28px square. */}
          <DropdownMenuContent className="w-auto" align="end">
            <DropdownMenuItem onSelect={() => setMoving(true)}>
              <FolderInputIcon className="size-3.5" />
              Move to another project…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* What the retired "Danger zone" heading used to say: the rule
                above and the red below are all that is left to say it. */}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              <Trash2Icon className="size-3.5" />
              Move to trash…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <MoveIssueDialog
        slug={slug}
        issueNumber={issue.number}
        open={moving}
        onOpenChange={(next) => {
          setMoving(next);
          returnFocus(next);
        }}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          returnFocus(next);
        }}
        title="Move this issue to the trash?"
        description={
          <>
            <strong>
              {formatRef(refPrefix, issue.number)} {issue.title}
            </strong>{" "}
            disappears from lists, search and references, and every write to it
            is refused. Nothing is erased: you can restore it from the trash,
            and its number is never reused.
          </>
        }
        confirmLabel="Move to trash"
        destructive
        pending={deleteIssue.isPending}
        onConfirm={() =>
          deleteIssue.mutate(issue.number, {
            // Redirect after a mutation — the page we are standing on is
            // about to stop being reachable for most viewers.
            onSuccess: () =>
              navigate({ to: "/projects/$slug", params: { slug } }),
          })
        }
      />
    </section>
  );
}
