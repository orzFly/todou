import { Button } from "@orz/ui/components/button";
import { ConfirmDialog } from "@orz/ui/components/confirm-dialog";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Attachment, AttachmentReference } from "@todou/shared";
import { DownloadIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { attachmentReferencesQuery } from "@/api/attachments.ts";
import { api, meQuery, projectQuery } from "@/api/queries.ts";
import {
  canDeleteAttachment,
  referenceLabel,
} from "@/components/issue/attachment-delete.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import { viewHrefFromDownload } from "@/lib/attachment-refs.ts";
import { pickSaveTarget, saveStream } from "@/lib/save-stream.ts";
import { tarStream } from "@/lib/tar.ts";
import { commentAnchor } from "@/lib/timeline-anchors.ts";
import type { Selection } from "@/lib/use-selection.ts";

/**
 * The bytes of one attachment, from the same origin whatever the storage.
 * `/download` answers with a 302 to a presigned bucket URL on S3, and a
 * script reading that cross-origin response needs a bucket CORS policy that
 * docs/deploy.md only recommends; `/view` is streamed by the server on every
 * backend, and its inline disposition means nothing to `fetch`.
 */
async function openAttachment(
  attachment: Attachment,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(viewHrefFromDownload(attachment.url));
  if (!res.ok || res.body === null) {
    throw new Error(
      `${attachment.filename}: download failed (HTTP ${res.status})`,
    );
  }
  return res.body;
}

/** A plain download of one file — the browser's own, no archive around it. */
function downloadOne(attachment: Attachment) {
  const anchor = document.createElement("a");
  anchor.href = attachment.url;
  anchor.download = attachment.filename;
  anchor.click();
}

function useBundleDownload(slug: string, issueNumber: number) {
  // Body bytes written so far, of `total`; null while idle.
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const start = async (files: readonly Attachment[]) => {
    if (files.length === 1) {
      downloadOne(files[0]);
      return;
    }
    const name = `${slug}-${issueNumber}-attachments.tar`;
    let target: Awaited<ReturnType<typeof pickSaveTarget>>;
    try {
      target = await pickSaveTarget(name, {
        description: "Tar archive",
        mime: "application/x-tar",
        extension: ".tar",
      });
    } catch (error) {
      toast.error((error as Error).message);
      return;
    }
    if (target === null) return;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    setProgress({ done: 0, total });
    let shown = 0;
    try {
      await saveStream(
        target,
        tarStream(
          files.map((file) => ({
            name: file.filename,
            size: file.size,
            mtime: new Date(file.created_at),
            open: () => openAttachment(file),
          })),
          // A render per whole percent, not per network chunk: a gigabyte
          // arrives in tens of thousands of them.
          (done) => {
            const percent = Math.floor((done / Math.max(total, 1)) * 100);
            if (percent !== shown) {
              shown = percent;
              setProgress({ done, total });
            }
          },
        ),
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return { start, progress };
}

/**
 * The actions over an attachment selection, for the list's header row:
 * download (everything when nothing is selected), and delete — held back
 * while the selection includes a file the reader may not delete.
 */
export function AttachmentBulkActions({
  slug,
  issueNumber,
  items,
  selection,
}: {
  slug: string;
  issueNumber: number;
  items: readonly Attachment[];
  selection: Selection<number>;
}) {
  const me = useQuery(meQuery);
  const project = useQuery(projectQuery(slug));
  const download = useBundleDownload(slug, issueNumber);
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();

  const chosen = items.filter((a) => selection.isSelected(a.id));
  const targets = chosen.length === 0 ? items : chosen;
  const deletable = chosen.filter((a) =>
    canDeleteAttachment(
      project.data?.viewer_role ?? null,
      me.data?.id,
      a.uploader.id,
    ),
  );

  const remove = useMutation({
    mutationFn: async (files: readonly Attachment[]) => {
      const results = await Promise.allSettled(
        files.map((f) => api.deleteAttachment(slug, f.id)),
      );
      return results.flatMap((r, i) =>
        r.status === "rejected"
          ? [{ file: files[i], reason: r.reason as Error }]
          : [],
      );
    },
    onSuccess: (failures) => {
      setConfirming(false);
      // Deleted files leave the list, and with it the selection; the ones
      // that failed stay selected for another try.
      if (failures.length > 0) {
        toast.error(
          failures.length === 1
            ? `${failures[0].file.filename}: ${failures[0].reason.message}`
            : `${failures.length} files were not deleted: ${failures[0].reason.message}`,
        );
      }
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["attachments", slug, issueNumber],
        }),
        queryClient.invalidateQueries({
          queryKey: ["timeline", slug, issueNumber],
        }),
      ]);
    },
  });

  const progress = download.progress;
  return (
    <div className="ml-auto flex items-center gap-1">
      <Button
        variant="ghost"
        size="xs"
        disabled={progress !== null}
        onClick={() => download.start(targets)}
        data-testid="attachment-bulk-download"
      >
        <DownloadIcon />
        {progress !== null
          ? `${Math.floor((progress.done / Math.max(progress.total, 1)) * 100)}%`
          : chosen.length === 0
            ? "Download all"
            : `Download ${chosen.length}`}
      </Button>
      {deletable.length > 0 && (
        // A disabled button takes no pointer events, so the reason hangs
        // off a wrapper: a reporter may delete only their own uploads, and
        // nothing on the rows says whose each file is.
        <span
          title={
            deletable.length < chosen.length
              ? "Some of these were uploaded by someone else"
              : undefined
          }
        >
          <Button
            variant="ghost"
            size="xs"
            className="hover:text-destructive"
            disabled={deletable.length < chosen.length}
            onClick={() => setConfirming(true)}
            data-testid="attachment-bulk-delete"
          >
            <Trash2Icon />
            Delete {chosen.length}
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${chosen.length} files?`}
        description="The files are erased and cannot be brought back."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(chosen)}
      >
        {confirming && (
          <BulkReferenceList
            slug={slug}
            issueNumber={issueNumber}
            files={chosen}
          />
        )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * The single-file dialog's "these still link it", for many files at once:
 * one list of places, each naming which of the files it links.
 */
function BulkReferenceList({
  slug,
  issueNumber,
  files,
}: {
  slug: string;
  issueNumber: number;
  files: readonly Attachment[];
}) {
  const references = useQueries({
    queries: files.map((f) => attachmentReferencesQuery(slug, f.id)),
  });
  const places = new Map<
    string,
    { ref: AttachmentReference; names: string[] }
  >();
  files.forEach((file, i) => {
    for (const ref of references[i].data ?? []) {
      const key = `${ref.issue_number}/${ref.comment_id ?? "body"}`;
      const place = places.get(key) ?? { ref, names: [] };
      place.names.push(file.filename);
      places.set(key, place);
    }
  });
  const failed = references.filter((r) => r.isError);
  return (
    <div className="min-w-0 space-y-2 text-sm">
      <ul className="max-h-40 overflow-y-auto">
        {files.map((f) => (
          <li key={f.id} title={f.filename} className="truncate font-medium">
            {f.filename}
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <LoadFailure
          message="Failed to load where these files are linked."
          detail={failed[0].error?.message}
          onRetry={() => {
            for (const r of failed) r.refetch();
          }}
          retrying={failed.some((r) => r.isFetching)}
        />
      )}
      {places.size > 0 && (
        <div data-testid="attachment-references">
          <p className="text-muted-foreground">
            These still link them, and will show them as deleted:
          </p>
          <ul className="mt-1 space-y-0.5">
            {[...places].map(([key, { ref, names }]) => (
              <li key={key} className="[overflow-wrap:anywhere]">
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
                </Link>{" "}
                <span className="text-muted-foreground">
                  {names.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
