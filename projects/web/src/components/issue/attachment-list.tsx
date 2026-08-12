import { useQuery } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import {
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  PaperclipIcon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import { attachmentsQuery, attachmentTextQuery } from "@/api/attachments.ts";
import { DocumentView } from "@/components/shared/document-card.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  formatSize,
  isTextDocument,
  type PreviewTarget,
  previewKind,
} from "@/lib/attachment-preview.ts";
import { attachmentHref } from "@/lib/attachment-refs.ts";

/** Modifier-clicks (new tab, forced download) keep native link behavior. */
function isPlainLeftClick(e: MouseEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

function AttachmentTextBody({
  target,
  slug,
  issueNumber,
}: {
  target: PreviewTarget;
  slug: string;
  issueNumber: number;
}) {
  const text = useQuery(attachmentTextQuery(target.url));
  if (text.isPending) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Loading {target.filename}…
      </p>
    );
  }
  if (text.isError) {
    return (
      <p className="py-8 text-center text-sm text-destructive">
        Failed to load {target.filename}: {text.error.message}
      </p>
    );
  }
  return (
    <div className="max-h-[75vh] overflow-auto">
      <DocumentView
        filename={target.filename}
        text={text.data}
        slug={slug}
        issueNumber={issueNumber}
      />
    </div>
  );
}

function AttachmentPreviewDialog({
  attachment,
  slug,
  issueNumber,
  onClose,
}: {
  attachment: PreviewTarget | null;
  slug: string;
  issueNumber: number;
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
            {previewKind(attachment) === "text" ? (
              <AttachmentTextBody
                target={attachment}
                slug={slug}
                issueNumber={issueNumber}
              />
            ) : (
              <img
                src={attachment.url}
                alt={attachment.filename}
                className="mx-auto max-h-[75vh] rounded-md object-contain"
              />
            )}
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {[
                  attachment.content_type,
                  attachment.size !== undefined
                    ? formatSize(attachment.size)
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
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

function attachmentIcon(attachment: {
  filename: string;
  content_type?: string;
}) {
  if (previewKind(attachment) === "image") return ImageIcon;
  if (isTextDocument(attachment)) return FileTextIcon;
  return FileIcon;
}

/**
 * Attachment list for an issue. Every row is a real link to the download
 * API (so copy-link/middle-click keep working); a plain click on anything
 * previewable (image or in-limit text) is hijacked into an in-page modal,
 * anything else falls through to the browser download.
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
        {items.map((attachment) => {
          const Icon = attachmentIcon(attachment);
          return (
            <li key={attachment.id}>
              <a
                href={attachment.url}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40"
                onClick={(e) => {
                  if (previewKind(attachment) !== null && isPlainLeftClick(e)) {
                    e.preventDefault();
                    setPreview(attachment);
                  }
                }}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium hover:underline">
                  {attachment.filename}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {formatSize(attachment.size)}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <AttachmentPreviewDialog
        attachment={preview}
        slug={slug}
        issueNumber={issueNumber}
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
  const url = attachment?.url ?? attachmentHref(slug, attachmentId, filename);

  return (
    <>
      <a
        href={url}
        className="font-medium text-foreground/80 hover:underline"
        onClick={(e) => {
          if (
            attachment &&
            previewKind(attachment) !== null &&
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
        slug={slug}
        issueNumber={issueNumber}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

/**
 * Rich attachment link for markdown bodies: `[text](…/download/name)`.
 * Resolves the full attachment from the issue's query when it can; until
 * then the URL and link text carry enough to stay a working download link.
 */
export function AttachmentRichLink({
  slug,
  issueNumber,
  attachmentId,
  href,
  fallbackName,
  children,
}: {
  slug: string;
  issueNumber: number;
  attachmentId: number;
  href: string;
  fallbackName: string;
  children?: ReactNode;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const target: PreviewTarget = attachment ?? {
    filename: fallbackName,
    url: href,
  };
  const Icon = attachmentIcon(target);

  return (
    <>
      <a
        href={attachment?.url ?? href}
        className="inline-flex items-center gap-1"
        onClick={(e) => {
          if (previewKind(target) !== null && isPlainLeftClick(e)) {
            e.preventDefault();
            setPreview(target);
          }
        }}
      >
        <Icon className="size-3.5 shrink-0" />
        {children ?? attachment?.filename ?? fallbackName}
      </a>
      <AttachmentPreviewDialog
        attachment={preview}
        slug={slug}
        issueNumber={issueNumber}
        onClose={() => setPreview(null)}
      />
    </>
  );
}

/**
 * Inline embedded image for markdown bodies: `![alt](…/download/name)`.
 * The download URL serves the bytes either way; this only adds the
 * click-to-preview affordance on top of the plain <img>.
 */
export function AttachmentInlineImage({
  slug,
  issueNumber,
  attachmentId,
  src,
  alt,
}: {
  slug: string;
  issueNumber: number;
  attachmentId: number;
  src: string;
  alt: string;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const target: PreviewTarget = attachment ?? {
    filename: alt !== "" ? alt : "image",
    url: src,
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: zoom is a mouse affordance; the preview dialog's links stay keyboard-reachable */}
      <img
        src={src}
        alt={alt}
        className="cursor-zoom-in"
        onClick={() => setPreview(target)}
      />
      <AttachmentPreviewDialog
        attachment={preview}
        slug={slug}
        issueNumber={issueNumber}
        onClose={() => setPreview(null)}
      />
    </>
  );
}
