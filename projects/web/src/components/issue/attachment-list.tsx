import { useQuery } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { DownloadIcon, FileIcon, ImageIcon, PaperclipIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";
import { attachmentsQuery } from "@/api/attachments.ts";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function isPreviewableImage(attachment: Attachment): boolean {
  return attachment.content_type.startsWith("image/");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Modifier-clicks (new tab, forced download) keep native link behavior. */
function isPlainLeftClick(e: MouseEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

function AttachmentPreviewDialog({
  attachment,
  onClose,
}: {
  attachment: Attachment | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={attachment !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl" aria-describedby={undefined}>
        {attachment && (
          <>
            <DialogTitle className="truncate pr-8">
              {attachment.filename}
            </DialogTitle>
            <img
              src={attachment.url}
              alt={attachment.filename}
              className="mx-auto max-h-[75vh] rounded-md object-contain"
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {attachment.content_type} · {formatSize(attachment.size)}
              </span>
              <a
                href={attachment.url}
                download={attachment.filename}
                className="inline-flex items-center gap-1 font-medium hover:underline"
              >
                <DownloadIcon className="size-3.5" />
                Download
              </a>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Attachment list for an issue. Every row is a real link to the download
 * API (so copy-link/middle-click keep working); a plain click on an image
 * is hijacked into an in-page preview modal, anything else falls through
 * to the browser download.
 */
export function AttachmentList({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const [preview, setPreview] = useState<Attachment | null>(null);
  const items = attachments.data ?? [];
  if (items.length === 0) return null;

  return (
    <section className="rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <PaperclipIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Attachments</span>
        <span className="text-muted-foreground">{items.length}</span>
      </div>
      <ul className="divide-y">
        {items.map((attachment) => (
          <li key={attachment.id}>
            <a
              href={attachment.url}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40"
              onClick={(e) => {
                if (isPreviewableImage(attachment) && isPlainLeftClick(e)) {
                  e.preventDefault();
                  setPreview(attachment);
                }
              }}
            >
              {isPreviewableImage(attachment) ? (
                <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium hover:underline">
                {attachment.filename}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatSize(attachment.size)}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <AttachmentPreviewDialog
        attachment={preview}
        onClose={() => setPreview(null)}
      />
    </section>
  );
}

/**
 * Inline filename link for "attached …" timeline events. The event payload
 * carries only id/filename, so content type and canonical URL come from the
 * issue's attachments query (already cached by AttachmentList).
 */
export function AttachmentEventLink({
  slug,
  issueNumber,
  attachmentId,
  filename,
}: {
  slug: string;
  issueNumber: number;
  attachmentId: number;
  filename: string;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const [preview, setPreview] = useState<Attachment | null>(null);
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const url =
    attachment?.url ??
    `/api/projects/${slug}/attachments/${attachmentId}/download`;

  return (
    <>
      <a
        href={url}
        className="font-medium text-foreground/80 hover:underline"
        onClick={(e) => {
          if (
            attachment &&
            isPreviewableImage(attachment) &&
            isPlainLeftClick(e)
          ) {
            e.preventDefault();
            setPreview(attachment);
          }
        }}
      >
        {filename}
      </a>
      <AttachmentPreviewDialog
        attachment={preview}
        onClose={() => setPreview(null)}
      />
    </>
  );
}
