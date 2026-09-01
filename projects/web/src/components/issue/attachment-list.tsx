import { useQuery } from "@tanstack/react-query";
import {
  AppWindowIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  PaperclipIcon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import { attachmentsQuery } from "@/api/attachments.ts";
import {
  AttachmentViewerDialog,
  type ViewerState,
  viewerStateFor,
} from "@/components/issue/attachment-viewer.tsx";
import {
  formatSize,
  isHtmlDocument,
  isTextDocument,
  type PreviewTarget,
  previewKind,
} from "@/lib/attachment-preview.ts";
import { attachmentAnchorHref, attachmentHref } from "@/lib/attachment-refs.ts";

/** Modifier-clicks (new tab, forced download) keep native link behavior. */
function isPlainLeftClick(e: MouseEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

function attachmentIcon(attachment: {
  filename: string;
  content_type?: string;
}) {
  if (previewKind(attachment) === "image") return ImageIcon;
  if (isHtmlDocument(attachment)) return AppWindowIcon;
  if (isTextDocument(attachment)) return FileTextIcon;
  return FileIcon;
}

/**
 * Attachment list for an issue. Every row is a real link (so copy-link and
 * middle-click keep working), pointing at /view for types a tab renders and
 * /download otherwise (T-201) — hence the separate download icon, which is
 * the only way left to save a viewable file. A plain click on anything
 * previewable (image, HTML, in-limit text) is hijacked into the viewer,
 * anything else falls through to the browser. The viewer pages across the
 * whole list (T-58).
 */
export function AttachmentList({
  slug,
  issueNumber,
}: {
  slug: string;
  issueNumber: number;
}) {
  const attachments = useQuery(attachmentsQuery(slug, issueNumber));
  const [viewer, setViewer] = useState<ViewerState | null>(null);
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
        {items.map((attachment, index) => {
          const Icon = attachmentIcon(attachment);
          return (
            <li
              key={attachment.id}
              className="flex items-center hover:bg-muted/40"
            >
              <a
                href={attachmentAnchorHref(attachment)}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-sm"
                onClick={(e) => {
                  if (previewKind(attachment) !== null && isPlainLeftClick(e)) {
                    e.preventDefault();
                    setViewer({ items, index });
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
              <a
                href={attachment.url}
                download={attachment.filename}
                aria-label={`download ${attachment.filename}`}
                className="shrink-0 py-2 pr-3 pl-2 text-muted-foreground hover:text-foreground"
              >
                <DownloadIcon className="size-3.5" />
              </a>
            </li>
          );
        })}
      </ul>
      <AttachmentViewerDialog
        state={viewer}
        onNavigate={(index) =>
          setViewer((prev) => (prev === null ? prev : { ...prev, index }))
        }
        onClose={() => setViewer(null)}
        slug={slug}
        issueNumber={issueNumber}
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
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const url = attachment
    ? attachmentAnchorHref(attachment)
    : attachmentHref(slug, attachmentId, filename);

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
            setViewer(
              viewerStateFor(
                attachments.data ?? [],
                attachments.data?.findIndex((a) => a.id === attachmentId) ?? -1,
                attachment,
              ),
            );
          }
        }}
      >
        {filename}
      </a>
      <AttachmentViewerDialog
        state={viewer}
        onNavigate={(index) =>
          setViewer((prev) => (prev === null ? prev : { ...prev, index }))
        }
        onClose={() => setViewer(null)}
        slug={slug}
        issueNumber={issueNumber}
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
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const target: PreviewTarget = attachment ?? {
    filename: fallbackName,
    url: href,
  };
  const Icon = attachmentIcon(target);

  return (
    <>
      <a
        href={attachment ? attachmentAnchorHref(attachment) : href}
        className="inline-flex items-center gap-1"
        onClick={(e) => {
          if (previewKind(target) !== null && isPlainLeftClick(e)) {
            e.preventDefault();
            setViewer(
              viewerStateFor(
                attachments.data ?? [],
                attachments.data?.findIndex((a) => a.id === attachmentId) ?? -1,
                target,
              ),
            );
          }
        }}
      >
        <Icon className="size-3.5 shrink-0" />
        {children ?? attachment?.filename ?? fallbackName}
      </a>
      <AttachmentViewerDialog
        state={viewer}
        onNavigate={(index) =>
          setViewer((prev) => (prev === null ? prev : { ...prev, index }))
        }
        onClose={() => setViewer(null)}
        slug={slug}
        issueNumber={issueNumber}
      />
    </>
  );
}

/**
 * Inline embedded image for markdown bodies: `![alt](…/download/name)`.
 * The download URL serves the bytes either way; this only adds the
 * click-to-view affordance on top of the plain <img>.
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
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const attachment = attachments.data?.find((a) => a.id === attachmentId);
  const target: PreviewTarget = attachment ?? {
    filename: alt !== "" ? alt : "image",
    url: src,
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: zoom is a mouse affordance; the viewer dialog's links stay keyboard-reachable */}
      <img
        src={src}
        alt={alt}
        className="cursor-zoom-in"
        onClick={() =>
          setViewer(
            viewerStateFor(
              attachments.data ?? [],
              attachments.data?.findIndex((a) => a.id === attachmentId) ?? -1,
              target,
            ),
          )
        }
      />
      <AttachmentViewerDialog
        state={viewer}
        onNavigate={(index) =>
          setViewer((prev) => (prev === null ? prev : { ...prev, index }))
        }
        onClose={() => setViewer(null)}
        slug={slug}
        issueNumber={issueNumber}
      />
    </>
  );
}
