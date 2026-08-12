import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "lucide-react";
import { useState } from "react";
import { attachmentTextQuery } from "@/api/attachments.ts";
import { DocumentView } from "@/components/shared/document-card.tsx";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  formatSize,
  type PreviewTarget,
  previewKind,
} from "@/lib/attachment-preview.ts";
import { viewHrefFromDownload } from "@/lib/attachment-refs.ts";
import { cn } from "@/lib/utils";

/** What the viewer is showing: a post's attachment set and a position. */
export type ViewerState = {
  items: PreviewTarget[];
  index: number;
};

function TextPane({
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
    <DocumentView
      filename={target.filename}
      text={text.data}
      slug={slug}
      issueNumber={issueNumber}
    />
  );
}

/** Paging can land on types that only download — say so instead of a 404. */
function DownloadOnlyPane({ target }: { target: PreviewTarget }) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
      <FileIcon className="size-8" />
      <span className="font-medium text-foreground">{target.filename}</span>
      <span>No inline preview for this file type.</span>
      <a
        href={target.url}
        download={target.filename}
        className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
      >
        <DownloadIcon className="size-3.5" />
        Download
      </a>
    </div>
  );
}

/**
 * The attachment viewer (#58): one dialog for images, sandboxed HTML,
 * text/markdown, and download-only fallbacks. A post's attachments page
 * with ‹ › / arrow keys (controls live in the title bar, never floated
 * over the content), and every kind offers native fullscreen.
 */
export function AttachmentViewerDialog({
  state,
  onNavigate,
  onClose,
  slug,
  issueNumber,
}: {
  state: ViewerState | null;
  onNavigate: (index: number) => void;
  onClose: () => void;
  slug: string;
  issueNumber: number;
}) {
  // "Maximize" fills the browser window without entering system fullscreen
  // (the form the reviewer picked on #58); the dialog stays a modal.
  const [maximized, setMaximized] = useState(false);

  const target = state?.items[state.index];
  const kind = target === undefined ? null : previewKind(target);
  const count = state?.items.length ?? 0;

  const step = (delta: number) => {
    if (state === null || count < 2) return;
    onNavigate((state.index + delta + count) % count);
  };

  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") step(-1);
          if (e.key === "ArrowRight") step(1);
        }}
        className={cn(
          "flex flex-col bg-background",
          // Maximized: fill the viewport (clearing the centering translate)
          // but stay a modal — Esc still closes it. sm:max-w-none is needed
          // to beat the dialog's built-in sm:max-w-sm cap.
          maximized
            ? "top-0 left-0 h-full w-full max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "sm:max-w-5xl",
        )}
      >
        {target && (
          <>
            <div className="flex items-center gap-1 pr-8">
              <DialogTitle className="min-w-0 flex-1 truncate">
                {target.filename}
              </DialogTitle>
              {count > 1 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="previous attachment"
                    onClick={() => step(-1)}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    {(state?.index ?? 0) + 1} / {count}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="next attachment"
                    onClick={() => step(1)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={maximized ? "restore size" : "maximize"}
                onClick={() => setMaximized((m) => !m)}
              >
                {maximized ? <MinimizeIcon /> : <MaximizeIcon />}
              </Button>
            </div>
            <div
              className={cn(
                "min-h-0 overflow-auto",
                maximized ? "flex-1" : "max-h-[75vh]",
              )}
            >
              {kind === "image" ? (
                <img
                  src={target.url}
                  alt={target.filename}
                  className={cn(
                    "mx-auto rounded-md object-contain",
                    maximized ? "h-full" : "max-h-[75vh]",
                  )}
                />
              ) : kind === "html" ? (
                // Never add allow-same-origin: attachments share the API's
                // origin, and a same-origin document's scripts could call
                // it with the viewer's cookies. allow-scripts alone keeps
                // the document on an opaque origin (the view route's CSP
                // backstops direct visits).
                <iframe
                  src={viewHrefFromDownload(target.url)}
                  sandbox="allow-scripts"
                  title={target.filename}
                  className={cn(
                    "w-full rounded-md border bg-white",
                    maximized ? "h-full" : "h-[75vh]",
                  )}
                />
              ) : kind === "text" ? (
                <TextPane
                  target={target}
                  slug={slug}
                  issueNumber={issueNumber}
                />
              ) : (
                <DownloadOnlyPane target={target} />
              )}
            </div>
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span className="truncate">
                {[
                  target.content_type,
                  target.size !== undefined
                    ? formatSize(target.size)
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                {kind === "html" && (
                  <a
                    href={viewHrefFromDownload(target.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-medium hover:underline"
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    Open in new tab
                  </a>
                )}
                <a
                  href={target.url}
                  download={target.filename}
                  className="inline-flex items-center gap-1 font-medium hover:underline"
                >
                  <DownloadIcon className="size-3.5" />
                  Download
                </a>
              </span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared open logic: clicking a reference views the whole post's
 * attachment set positioned on the clicked one; references that never
 * resolved (deleted id, stale link) view as a single-item set.
 */
export function viewerStateFor(
  items: PreviewTarget[],
  index: number,
  fallback: PreviewTarget,
): ViewerState {
  return index >= 0 ? { items, index } : { items: [fallback], index: 0 };
}
