import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type Attachment,
  type AttachmentReference,
  can,
  type MemberRole,
} from "@todou/shared";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { attachmentReferencesQuery } from "@/api/attachments.ts";
import { api, meQuery, projectQuery } from "@/api/queries.ts";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { commentAnchor } from "@/lib/timeline-anchors.ts";

/**
 * Mirror of the server's two gates (T-567): your own file at
 * `attachment.delete`, anyone's at `attachment.delete_any`.
 */
export function canDeleteAttachment(
  role: MemberRole | null,
  viewerId: number | undefined,
  uploaderId: number,
): boolean {
  if (can(role, "attachment.delete_any")) return true;
  return viewerId === uploaderId && can(role, "attachment.delete");
}

/**
 * The trash button on one attachment row, and the confirmation behind it.
 * Renders nothing for a reader who may not delete this file.
 */
export function AttachmentDeleteButton({
  slug,
  issueNumber,
  attachment,
}: {
  slug: string;
  issueNumber: number;
  attachment: Attachment;
}) {
  const me = useQuery(meQuery);
  const project = useQuery(projectQuery(slug));
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteAttachment(slug, attachment.id),
    onSuccess: () => {
      setOpen(false);
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["attachments", slug, issueNumber],
        }),
        queryClient.invalidateQueries({
          queryKey: ["timeline", slug, issueNumber],
        }),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });

  if (
    !canDeleteAttachment(
      project.data?.viewer_role ?? null,
      me.data?.id,
      attachment.uploader.id,
    )
  ) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        aria-label={`delete ${attachment.filename}`}
        onClick={() => setOpen(true)}
        className="shrink-0 py-2 pr-3 pl-1 text-muted-foreground hover:text-destructive"
      >
        <Trash2Icon className="size-3.5" />
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${attachment.filename}?`}
        description="The file is erased and cannot be brought back."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        {open && (
          <ReferenceList
            slug={slug}
            attachmentId={attachment.id}
            issueNumber={issueNumber}
          />
        )}
      </ConfirmDialog>
    </>
  );
}

function ReferenceList({
  slug,
  attachmentId,
  issueNumber,
}: {
  slug: string;
  attachmentId: number;
  issueNumber: number;
}) {
  const references = useQuery(attachmentReferencesQuery(slug, attachmentId));
  if (references.isPending) return <Skeleton className="h-4 w-40" />;
  if (references.isError) {
    return (
      <LoadFailure
        message="Failed to load where this file is linked."
        detail={references.error.message}
        onRetry={() => references.refetch()}
        retrying={references.isFetching}
      />
    );
  }
  if (references.data.length === 0) return null;
  return (
    <div className="text-sm" data-testid="attachment-references">
      <p className="text-muted-foreground">
        These still link it, and will show it as deleted:
      </p>
      <ul className="mt-1 flex flex-wrap gap-x-3">
        {references.data.map((ref) => (
          <li key={`${ref.issue_number}/${ref.comment_id ?? "body"}`}>
            <Link
              to="/projects/$slug/issues/$number"
              params={{ slug, number: String(ref.issue_number) }}
              hash={
                ref.comment_id === null
                  ? undefined
                  : commentAnchor(ref.comment_id)
              }
              className="font-medium hover:underline"
            >
              {referenceLabel(ref, issueNumber)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `#12 description`, `#comment-88`, or `#12#comment-88` off this card. */
function referenceLabel(ref: AttachmentReference, here: number): string {
  if (ref.comment_id === null) return `${ref.issue_ref} description`;
  const comment = `#comment-${ref.comment_id}`;
  return ref.issue_number === here ? comment : `${ref.issue_ref}${comment}`;
}
