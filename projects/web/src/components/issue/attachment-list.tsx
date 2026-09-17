import { useQuery } from "@tanstack/react-query";
import {
  AppWindowIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  ImageIcon,
  PaperclipIcon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import { attachmentsQuery } from "@/api/attachments.ts";
import { useBoxedRefLinks } from "@/api/prefs.ts";
import {
  AttachmentViewerDialog,
  type ViewerState,
  viewerStateFor,
} from "@/components/issue/attachment-viewer.tsx";
import { SidebarSection } from "@/components/issue/sidebar-section.tsx";
import {
  RICH_CHIP_ICON,
  RICH_CHIP_LABEL,
  RICH_CHIP_SKIN,
  RICH_CHIP_STRUCTURE,
} from "@/components/shared/rich-chip.ts";
import {
  formatSize,
  isHtmlDocument,
  isTextDocument,
  type PreviewTarget,
  previewKind,
} from "@/lib/attachment-preview.ts";
import { attachmentAnchorHref, attachmentHref } from "@/lib/attachment-refs.ts";
import { cn } from "@/lib/utils.ts";

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

/** Rows a folded list keeps on screen — its newest end. */
const CAP = 5;
/**
 * Below this many hidden rows, folding is a worse deal than the scroll it
 * saves: the toggle is a row of its own and as tall as one (37px), so hiding
 * one row saves nothing at all and hiding two saves a single row's height,
 * both at the price of a click and of the section changing shape the moment
 * a sixth file arrives.
 */
const MIN_HIDDEN = 3;

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
  // Not persisted anywhere: expanding is "show me now", not a preference.
  const [expanded, setExpanded] = useState(false);
  const items = attachments.data ?? [];
  if (items.length === 0) return null;

  const collapsible = items.length >= CAP + MIN_HIDDEN;
  const folded = collapsible && !expanded;
  // The fold takes the head off an unchanged ascending list rather than
  // reversing it: the same array is what `attach list`, the `attached …`
  // events and the viewer's previous/next all page through, and a list that
  // reads newest-first here would contradict every one of them.
  const shown = folded ? items.slice(-CAP) : items;
  const hiddenBefore = items.length - shown.length;

  return (
    <section className="rounded-lg border" id="attachments">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
        <PaperclipIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Attachments</span>
        <span className="text-muted-foreground">{items.length}</span>
      </div>
      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-1 border-b px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          data-testid="attachment-fold-toggle"
        >
          {folded ? (
            <>
              <ChevronDownIcon className="size-3.5" />
              展开其余 {items.length - CAP} 个
            </>
          ) : (
            <>
              <ChevronUpIcon className="size-3.5" />
              收起
            </>
          )}
        </button>
      )}
      <ul className="divide-y">
        {shown.map((attachment, shownIndex) => {
          // The viewer pages through the whole list, so a row hands it its
          // place in `items` — the fold's offset put the first visible row
          // somewhere in the middle.
          const index = shownIndex + hiddenBefore;
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
                {/* Hidden below `sm`: the whole section is ~360px there, and
                    a third right-hand column would eat the filename, which is
                    the one thing on the row nothing else replaces. */}
                <span
                  className="hidden shrink-0 text-xs text-muted-foreground sm:inline"
                  title={attachment.created_at}
                >
                  {new Date(attachment.created_at).toLocaleString()}
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

/** Rows the sidebar shows — four fit beside the section's own heading. */
const SIDEBAR_CAP = 4;

/**
 * "Attachments" sidebar section (T-369), in the shape of `SpecSidebarSection`
 * next door: the newest few files, sticky beside a long timeline, so the
 * mockup someone attached at the top of the card is still one click away at
 * comment forty. The body section keeps the full list — 240px has no room
 * for a size or a download button — and the heading jumps to it.
 */
export function AttachmentSidebarSection({
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

  // Same ascending order as the body section, tail first on screen: one list
  // read two ways in one viewport is a mental model too many.
  const shown = items.slice(-SIDEBAR_CAP);
  const hiddenBefore = items.length - shown.length;

  return (
    <SidebarSection
      name="attachments"
      testId="attachment-sidebar"
      title={
        <a href="#attachments">
          Attachments <span className="normal-case">{items.length}</span>
        </a>
      }
    >
      <ul>
        {shown.map((attachment, shownIndex) => {
          const Icon = attachmentIcon(attachment);
          return (
            <li key={attachment.id}>
              <a
                href={attachmentAnchorHref(attachment)}
                title={attachment.filename}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted"
                onClick={(e) => {
                  if (previewKind(attachment) !== null && isPlainLeftClick(e)) {
                    e.preventDefault();
                    setViewer({
                      items,
                      index: shownIndex + hiddenBefore,
                    });
                  }
                }}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs">{attachment.filename}</span>
              </a>
            </li>
          );
        })}
      </ul>
      {/* Only while this list is short of the full set — `hiddenBefore`, not
          the body panel's own fold, which starts three files later: between
          five and seven files the body stays unfolded while the sidebar has
          already dropped some, and that is exactly when this row is needed.

          A real anchor, so middle-click and ⌘-click behave. The landing is
          not swallowed by the floating title bar: `useScrollInsets` writes
          its height into `scroll-padding-top`, which native anchor jumps
          already honour. */}
      {hiddenBefore > 0 && (
        <a
          href="#attachments"
          className="text-xs text-muted-foreground hover:underline"
        >
          全部 {items.length} 个 ↓
        </a>
      )}
      <AttachmentViewerDialog
        state={viewer}
        onNavigate={(index) =>
          setViewer((prev) => (prev === null ? prev : { ...prev, index }))
        }
        onClose={() => setViewer(null)}
        slug={slug}
        issueNumber={issueNumber}
      />
    </SidebarSection>
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
  const boxed = useBoxedRefLinks();
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
        // The label shares the chip's truncating child, so a long filename is
        // cut where it used to wrap and stay whole.
        title={attachment?.filename ?? fallbackName}
        className={cn(
          RICH_CHIP_STRUCTURE,
          boxed ? RICH_CHIP_SKIN : "hover:underline",
        )}
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
        <Icon className={RICH_CHIP_ICON} />
        <span className={RICH_CHIP_LABEL}>
          {children ?? attachment?.filename ?? fallbackName}
        </span>
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
  className,
}: {
  slug: string;
  issueNumber: number;
  attachmentId: number;
  src: string;
  alt: string;
  /**
   * Classes the markdown pipeline put on the `<img>` before this component
   * replaced it. Dropping them would drop the spec diff's decorations, which
   * are painted on the element itself rather than on a wrapper (T-223).
   */
  className?: string;
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
        className={cn("cursor-zoom-in", className)}
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
