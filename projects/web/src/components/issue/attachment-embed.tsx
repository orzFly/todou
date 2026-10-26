import { useQuery } from "@tanstack/react-query";
import type { Attachment } from "@todou/shared";
import { FileTextIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { attachmentsQuery, attachmentTextQuery } from "@/api/attachments.ts";
import { AttachmentRichLink } from "@/components/issue/attachment-list.tsx";
import {
  DocumentCard,
  type DocumentRender,
} from "@/components/shared/document-card.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import {
  documentKind,
  formatSize,
  isTextDocument,
  textPreviewGate,
} from "@/lib/attachment-preview.ts";
import { attachmentAnchorHref } from "@/lib/attachment-refs.ts";
import { cn } from "@/lib/utils";

/** Card-shaped stand-in for the states that have no document body to show. */
function EmbedShell({
  filename,
  href,
  meta,
  children,
  className,
}: {
  filename: string;
  href: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn("my-2 block overflow-hidden rounded-lg border", className)}
    >
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
  className,
  render,
}: {
  attachment: Attachment;
  slug: string;
  issueNumber: number;
  className?: string;
  render: DocumentRender;
}) {
  const text = useQuery(attachmentTextQuery(attachment.url));
  if (text.isPending) {
    return (
      <EmbedShell
        filename={attachment.filename}
        href={attachmentAnchorHref(attachment)}
        meta={formatSize(attachment.size)}
        className={className}
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
        className={className}
        meta={formatSize(attachment.size)}
      >
        <LoadFailure
          message={`Failed to load: ${text.error.message}`}
          detail={text.error.message}
          onRetry={() => text.refetch()}
          retrying={text.isFetching}
        />
      </EmbedShell>
    );
  }
  return (
    <DocumentCard
      filename={attachment.filename}
      text={text.data}
      render={render}
      slug={slug}
      issueNumber={issueNumber}
      className={className}
      meta={formatSize(attachment.size)}
      downloadUrl={attachment.url}
    />
  );
}

/**
 * Inline document embed for markdown bodies: `![…](…/download/name.md)` —
 * image syntax pointed at a text attachment. Same mental model as embedded
 * images, but the body is a height-capped DocumentCard that expands to the
 * full document. Past the preview size it waits to be asked and then shows
 * plain text, like the viewer (T-582); past the hard limit, or not text after
 * all, it stays a download-only card.
 */
export function AttachmentDocumentEmbed({
  slug,
  issueNumber,
  attachmentId,
  href,
  fallbackName,
  className,
}: {
  slug: string;
  issueNumber: number;
  attachmentId: number;
  href: string;
  fallbackName: string;
  className?: string;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const [asked, setAsked] = useState(false);

  if (attachment === undefined) {
    if (attachments.isPending) {
      return (
        <EmbedShell filename={fallbackName} href={href} className={className}>
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
        className={className}
      />
    );
  }
  const gate = isTextDocument(attachment) ? textPreviewGate(attachment) : null;
  if (gate === null || gate === "refuse" || (gate === "ask" && !asked)) {
    return (
      <EmbedShell
        filename={attachment.filename}
        href={attachmentAnchorHref(attachment)}
        meta={formatSize(attachment.size)}
        className={className}
      >
        {gate === null ? (
          "No inline preview for this file type."
        ) : gate === "refuse" ? (
          "This file is too large to preview."
        ) : (
          <>
            Large files aren't previewed automatically.{" "}
            <button
              type="button"
              onClick={() => setAsked(true)}
              className="cursor-pointer font-medium text-foreground hover:underline"
            >
              Preview anyway
            </button>
          </>
        )}
      </EmbedShell>
    );
  }
  return (
    <LoadedEmbed
      attachment={attachment}
      slug={slug}
      issueNumber={issueNumber}
      className={className}
      render={gate === "ask" ? "plain" : documentKind(attachment)}
    />
  );
}
