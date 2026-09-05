import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { can, type MoveIssueResult, type Project } from "@todou/shared";
import { useState } from "react";
import { movePreviewQuery, useMoveIssueMutation } from "@/api/issues.ts";
import { projectsQuery } from "@/api/queries.ts";
import { ProjectPicker } from "@/components/project-picker.tsx";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Pick a destination, see what the move would change, confirm.
 *
 * A plain Dialog rather than ConfirmDialog: that one is documented for
 * reversible actions, and this one renumbers the card and leaves a
 * permanent tombstone behind. The preview between the two steps is the
 * server's own `dry_run`, so what is shown is what will happen.
 */
export function MoveIssueDialog({
  slug,
  issueNumber,
  open,
  onOpenChange,
}: {
  slug: string;
  issueNumber: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [target, setTarget] = useState<Project | null>(null);
  const navigate = useNavigate();
  const projects = useQuery(projectsQuery);
  const preview = useQuery(
    movePreviewQuery(slug, issueNumber, target?.slug ?? null),
  );
  const move = useMoveIssueMutation(slug);

  const candidates = (projects.data ?? []).filter(
    (project) =>
      project.slug !== slug &&
      // The server checks this again; listing only what the mover can
      // actually write into keeps the picker from offering dead ends. The
      // destination's own capability, not the source's: what is being asked
      // is whether a card may be brought *into* this project.
      can(project.viewer_role ?? null, "issue.move_in"),
  );

  const close = (next: boolean) => {
    if (!next) setTarget(null);
    onOpenChange(next);
  };

  const confirm = () => {
    if (target === null) return;
    move.mutate(
      { issueNumber, toProject: target.slug },
      {
        onSuccess: (result) => {
          close(false);
          void navigate({
            to: "/projects/$slug/issues/$number",
            params: {
              slug: result.moved_to.slug,
              number: String(result.moved_to.number),
            },
            replace: true,
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to another project</DialogTitle>
          <DialogDescription>
            The card takes a new number there. Its current address keeps working
            — links, comment permalinks and attachment URLs all redirect.
          </DialogDescription>
        </DialogHeader>

        {target === null ? (
          <ProjectPicker
            projects={candidates}
            onSelect={setTarget}
            label="Move to project"
          />
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              Moving to <span className="font-medium">{target.name}</span>
            </p>
            {preview.isPending && (
              <p className="text-muted-foreground">Checking what changes…</p>
            )}
            {preview.isError && (
              <p className="text-destructive">
                {(preview.error as Error).message}
              </p>
            )}
            {preview.data && <Mapping preview={preview.data} />}
          </div>
        )}

        <DialogFooter>
          {target === null ? (
            <Button variant="outline" onClick={() => close(false)}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setTarget(null)}>
                Back
              </Button>
              <Button
                onClick={confirm}
                disabled={move.isPending || preview.isPending}
              >
                {move.isPending ? "Moving…" : `Move to ${target.slug}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Everything the destination cannot take verbatim, named before the move. */
function Mapping({ preview }: { preview: MoveIssueResult }) {
  const { status, dropped_labels, dropped_assignees } = preview.mapping;
  return (
    <ul className="space-y-1 text-muted-foreground">
      <li>
        Number:{" "}
        {preview.moved_to.number === null
          ? "a new one"
          : `${preview.moved_to.number}, its previous number there`}
      </li>
      {status.from !== status.to && (
        <li>
          Status: {status.from} → {status.to}
        </li>
      )}
      {dropped_labels.length > 0 && (
        <li className="text-amber-700 dark:text-amber-500">
          Labels dropped: {dropped_labels.join(", ")}
        </li>
      )}
      {dropped_assignees.length > 0 && (
        <li className="text-amber-700 dark:text-amber-500">
          Assignees dropped:{" "}
          {dropped_assignees.map((user) => `@${user.login}`).join(", ")}
        </li>
      )}
    </ul>
  );
}
