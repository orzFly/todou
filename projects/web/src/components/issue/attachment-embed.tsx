import { useQuery } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { FileTextIcon } from "lucide-react";
import type { ReactNode } from "react";
import { attachmentsQuery, attachmentTextQuery } from "@/api/attachments.ts";
import { AttachmentRichLink } from "@/components/issue/attachment-list.tsx";
import { DocumentCard } from "@/components/shared/document-card.tsx";
import {
  formatSize,
  isMarkdownDocument,
  isTextDocument,
  TEXT_PREVIEW_MAX_BYTES,
} from "@/lib/attachment-preview.ts";
import { attachmentAnchorHref } from "@/lib/attachment-refs.ts";

/** Card-shaped stand-in for the states that have no document body to show. */
function EmbedShell({
  filename,
  href,
  meta,
  children,
}: {
  filename: string;
  href: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <span className="my-2 block overflow-hidden rounded-lg border">
      <span className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <a href={href} className="truncate font-medium hover:underline">
          {filename}
        </a>
        {meta !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>
        )}
      </span>
      <span className="block px-3 py-2 text-sm text-muted-foreground">
        {children}
      </span>
    </span>
  );
}

function LoadedEmbed({
  attachment,
  slug,
  issueNumber,
}: {
  attachment: Attachment;
  slug: string;
  issueNumber: number;
}) {
  const text = useQuery(attachmentTextQuery(attachment.url));
  if (text.isPending) {
    return (
      <EmbedShell
        filename={attachment.filename}
        href={attachmentAnchorHref(attachment)}
        meta={formatSize(attachment.size)}
      >
        Loading…
      </EmbedShell>
    );
  }
  if (text.isError) {
    return (
      <EmbedShell
        filename={attachment.filename}
        href={attachmentAnchorHref(attachment)}
        meta={formatSize(attachment.size)}
      >
        Failed to load: {text.error.message}
      </EmbedShell>
    );
  }
  return (
    <DocumentCard
      filename={attachment.filename}
      text={text.data}
      render={isMarkdownDocument(attachment) ? "markdown" : "code"}
      slug={slug}
      issueNumber={issueNumber}
      refDate={attachment.created_at}
      meta={formatSize(attachment.size)}
      downloadUrl={attachment.url}
    />
  );
}

/**
 * Inline document embed for markdown bodies: `![…](…/download/name.md)` —
 * image syntax pointed at a text attachment. Same mental model as embedded
 * images, but the body is a height-capped DocumentCard that expands to the
 * full document. Attachments over the preview limit (or that turn out not
 * to be text) stay a download-only card.
 */
export function AttachmentDocumentEmbed({
  slug,
  issueNumber,
  attachmentId,
  href,
  fallbackName,
}: {
  slug: string;
  issueNumber: number;
  attachmentId: number;
  href: string;
  fallbackName: string;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const attachment = attachments.data?.find((a) => a.id === attachmentId);

  if (attachment === undefined) {
    if (attachments.isPending) {
      return (
        <EmbedShell filename={fallbackName} href={href}>
          Loading…
        </EmbedShell>
      );
    }
    // Unknown id (deleted attachment, stale reference): degrade to the rich
    // link so the reference at least stays a working download URL.
    return (
      <AttachmentRichLink
        slug={slug}
        issueNumber={issueNumber}
        attachmentId={attachmentId}
        href={href}
        fallbackName={fallbackName}
      />
    );
  }
  if (!isTextDocument(attachment) || attachment.size > TEXT_PREVIEW_MAX_BYTES) {
    return (
      <EmbedShell
        filename={attachment.filename}
        href={attachmentAnchorHref(attachment)}
        meta={formatSize(attachment.size)}
      >
        Too large to preview — download to view.
      </EmbedShell>
    );
  }
  return (
    <LoadedEmbed
      attachment={attachment}
      slug={slug}
      issueNumber={issueNumber}
    />
  );
}
