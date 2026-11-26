import { cn } from "@orz/ui";
import { Button } from "@orz/ui/components/button";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
  DialogTitleBar,
} from "@orz/ui/components/dialog";
import { writeClipboard } from "@orz/ui/lib/clipboard";
import { useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { attachmentTextQuery } from "@/api/attachments.ts";
import {
  CompareBar,
  CompareCanvas,
} from "@/components/issue/compare-canvas.tsx";
import { DiagramCanvas } from "@/components/issue/diagram-canvas.tsx";
import { ImageCanvas } from "@/components/issue/image-canvas.tsx";
import type { Widening } from "@/components/issue/use-zoom-pan.ts";
import {
  type DocumentRender,
  DocumentView,
} from "@/components/shared/document-card.tsx";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import {
  documentKind,
  formatSize,
  opensInBrowserTab,
  type PreviewTarget,
  previewKind,
  TEXT_PREVIEW_HARD_MAX_BYTES,
  textPreviewGate,
} from "@/lib/attachment-preview.ts";
import { viewHrefFromDownload } from "@/lib/attachment-refs.ts";

/**
 * Where the footer's "Open in new tab" goes, if anywhere. An object URL is
 * never opened bare: as a page of its own it would run in this app's origin,
 * outside the sandbox /view gives an uploaded file, so a staged file goes
 * through the sandboxed page its `tabUrl` names.
 */
function newTabHref(target: PreviewTarget): string | null {
  if (!opensInBrowserTab(target)) return null;
  if (target.tabUrl !== undefined) return target.tabUrl;
  if (target.url.startsWith("blob:")) return null;
  return viewHrefFromDownload(target.url);
}

// Long enough to cover a pointer crossing the image between two controls,
// short enough that leaving for good does not read as the viewer lagging.
const RELEASE_DELAY = 400;
const RELEASE_NOW = ["keydown", "pointerdown", "wheel"] as const;

/** One side of an image comparison, as the viewer draws and offers it. */
export type CompareImage = {
  /** The side's tag, such as "v2". */
  label: string;
  /** Where it is drawn and downloaded from. */
  src: string;
  filename: string;
  /** Natural size, already measured where the comparison was drawn. */
  size: { width: number; height: number };
  /** Known only when the image resolved to an attachment. */
  contentType?: string;
  bytes?: number;
};

/** One side of a diagram comparison: the coloured SVG and its mermaid source. */
export type CompareDiagram = {
  label: string;
  svg: string;
  source: string;
  size: { width: number; height: number };
};

export type ImagePair = {
  kind?: undefined;
  before: CompareImage;
  after: CompareImage;
};

/** A changed mermaid fence (T-773). */
export type DiagramPair = {
  kind: "diagram";
  /** The block's own, so paging from one diagram to another starts at fit. */
  key: string;
  /** The fence's title, or "diagram". */
  title: string;
  /** Such as "sequence" or "flowchart". */
  diagramType: string;
  before: CompareDiagram;
  after: CompareDiagram;
};

export type ComparePair = ImagePair | DiagramPair;

/** A single mermaid fence (T-773). */
export type DiagramView = {
  key: string;
  title: string;
  diagramType: string;
  svg: string;
  source: string;
  size: { width: number; height: number };
};

/**
 * What the viewer is showing, and the position in it: a post's attachment
 * set, the comparisons on a page (T-733), or one diagram (T-773).
 */
export type ViewerState =
  | { items: PreviewTarget[]; index: number }
  | { compare: ComparePair[]; index: number }
  | { diagram: DiagramView };

type TextPaneProps = {
  target: PreviewTarget;
  slug?: string;
  issueNumber?: number;
  toolbar: HTMLElement | null;
};

/**
 * A text attachment past the auto-preview size waits to be asked, and then
 * shows as plain text; past the hard limit it never previews (T-582). The
 * answer holds for this opening only: the pane is keyed by URL.
 */
function TextPane(props: TextPaneProps) {
  const { target } = props;
  const [asked, setAsked] = useState(false);
  const gate = textPreviewGate({ ...target, size: target.size ?? 0 });
  if (gate === "refuse") {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
        <FileIcon className="size-8" />
        <span className="font-medium text-foreground">
          This file is too large to preview.
        </span>
        <span>Previews stop at {formatSize(TEXT_PREVIEW_HARD_MAX_BYTES)}.</span>
      </div>
    );
  }
  if (gate === "ask" && !asked) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
        <FileIcon className="size-8" />
        <span className="font-medium text-foreground">
          Large files aren't previewed automatically.
        </span>
        <Button variant="outline" size="sm" onClick={() => setAsked(true)}>
          Preview anyway
        </Button>
      </div>
    );
  }
  return (
    <LoadedTextPane
      {...props}
      render={gate === "ask" ? "plain" : documentKind(target)}
    />
  );
}

function LoadedTextPane({
  target,
  slug,
  issueNumber,
  toolbar,
  render,
}: TextPaneProps & { render: DocumentRender }) {
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
      <div className="py-8 text-center">
        <LoadFailure
          message={`Failed to load ${target.filename}: ${text.error.message}`}
          detail={text.error.message}
          onRetry={() => text.refetch()}
          retrying={text.isFetching}
          className="justify-center"
        />
      </div>
    );
  }
  return (
    <DocumentView
      filename={target.filename}
      text={text.data}
      render={render}
      slug={slug}
      issueNumber={issueNumber}
      toolbar={toolbar}
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
 * The attachment viewer (T-58): one dialog for images, sandboxed HTML,
 * text/markdown, and download-only fallbacks. A post's attachments page
 * with ‹ › / arrow keys (controls live in the title bar, never floated
 * over the content), and every kind offers native fullscreen. A page's
 * image comparisons page the same way, two images at one zoom (T-733).
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
  /** Markdown context for a text file; a staged file has no card yet. */
  slug?: string;
  issueNumber?: number;
}) {
  // "Maximize" fills the browser window without entering system fullscreen
  // (the form the reviewer picked on T-58); the dialog stays a modal.
  const [maximized, setMaximized] = useState(false);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  const imageHeight = useRef<number | null>(null);
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const widening = useRef<Widening>({ asked: null, rest: null });

  const target =
    state !== null && "items" in state ? state.items[state.index] : undefined;
  const pair =
    state !== null && "compare" in state
      ? state.compare[state.index]
      : undefined;
  const diagram =
    state !== null && "diagram" in state ? state.diagram : undefined;
  const kind =
    pair !== undefined
      ? "compare"
      : diagram !== undefined
        ? "diagram"
        : target === undefined
          ? null
          : previewKind(target);
  const tabHref = target === undefined ? null : newTabHref(target);
  // Paging between images tweens from one's height to the next; from
  // anything else, including a closed viewer, the image lands at once.
  // The width a zoom widened the dialog to goes the same way, at once.
  useEffect(() => {
    if (kind === "image" || kind === "compare" || kind === "diagram") return;
    imageHeight.current = null;
    widening.current = { asked: null, rest: null };
    if (dialog !== null) dialog.style.minWidth = "";
  }, [kind, dialog]);
  const count =
    state === null
      ? 0
      : "items" in state
        ? state.items.length
        : "compare" in state
          ? state.compare.length
          : 1;
  const noun = pair !== undefined ? "comparison" : "attachment";

  // While the pointer is over − 100%▾ + or ‹ ›, the image keeps the height
  // it had when the pointer arrived, and takes its own once the pointer
  // leaves: the dialog is centred, so a height change slides the title bar
  // out from under the pointer, and the next click on + lands on the image
  // and toggles back to fit (T-548), or the next click on › misses (T-556).
  // One region for both groups, so crossing the gap between them is not a
  // leave. Listened to on the DOM rather than through React: the zoom
  // controls are portalled in from ImageCanvas, so in React's tree they sit
  // outside this region, while the zoom menu's items, portalled out to the
  // body, sit inside it — and choosing Fit or 100% there should not be held.
  // Leaving lets go only after RELEASE_DELAY, so a trip from one control to
  // another the long way round, over the image, is not a leave either
  // (T-559); a key, a press or a wheel in the meantime lets go at once,
  // since the pointer is no longer travelling.
  const [holdRegion, setHoldRegion] = useState<HTMLElement | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  useEffect(() => {
    if (holdRegion === null) return;
    let pending: number | undefined;
    const cancel = () => {
      window.clearTimeout(pending);
      pending = undefined;
      for (const type of RELEASE_NOW)
        window.removeEventListener(type, release, true);
    };
    const release = () => {
      cancel();
      setHeld(null);
    };
    const enter = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      if (pending !== undefined) cancel();
      else setHeld(imageHeight.current);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || pending !== undefined) return;
      pending = window.setTimeout(release, RELEASE_DELAY);
      for (const type of RELEASE_NOW)
        window.addEventListener(type, release, {
          capture: true,
          passive: true,
        });
    };
    holdRegion.addEventListener("pointerenter", enter);
    holdRegion.addEventListener("pointerleave", leave);
    return () => {
      cancel();
      holdRegion.removeEventListener("pointerenter", enter);
      holdRegion.removeEventListener("pointerleave", leave);
    };
  }, [holdRegion]);
  // Closing unmounts the region under the pointer, which never reports
  // leaving it.
  const open = state !== null;
  useEffect(() => {
    if (!open) setHeld(null);
  }, [open]);
  // A comparison's split and opacity carry across paging and mode changes,
  // and start over at every opening.
  const [cut, setCut] = useState(50);
  const [fade, setFade] = useState(50);
  useEffect(() => {
    if (open) return;
    setCut(50);
    setFade(50);
  }, [open]);

  const step = (delta: number) => {
    if (state === null || "diagram" in state || count < 2) return;
    onNavigate((state.index + delta + count) % count);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={setDialog}
        aria-describedby={undefined}
        showCloseButton={false}
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
        {(target !== undefined ||
          pair !== undefined ||
          diagram !== undefined) && (
          <>
            {/* On touch each icon button keeps the rest of 36px beside it as
                margin, so a gap on top of that only takes room a phone's
                filename needs. */}
            <DialogTitleBar className="touch:gap-0">
              {/* The title lays out as a flex row after its marker, so the
                  ellipsis has to sit on the text's own box, and that box
                  needs a line tall enough to keep the descenders it clips. */}
              <DialogTitle className="min-w-0 flex-1">
                <span className="truncate leading-normal">
                  {diagram !== undefined
                    ? diagram.title
                    : pair === undefined
                      ? target?.filename
                      : pair.kind === "diagram"
                        ? pair.title
                        : pair.before.filename === pair.after.filename
                          ? pair.after.filename
                          : `${pair.before.filename} → ${pair.after.filename}`}
                </span>
              </DialogTitle>
              <span
                ref={setHoldRegion}
                // Alone, the zoom controls need no box; an empty one would
                // add a gap beside a lone file that shows neither group.
                className={cn(
                  "items-center gap-1 touch:gap-0",
                  count > 1 ? "flex" : "contents",
                )}
              >
                <span ref={setToolbar} className="contents" />
                {count > 1 && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`previous ${noun}`}
                      onClick={() => step(-1)}
                    >
                      <ChevronLeftIcon />
                    </Button>
                    <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {(state !== null && "index" in state ? state.index : 0) +
                        1}{" "}
                      / {count}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`next ${noun}`}
                      onClick={() => step(1)}
                    >
                      <ChevronRightIcon />
                    </Button>
                  </>
                )}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={maximized ? "restore size" : "maximize"}
                onClick={() => setMaximized((m) => !m)}
              >
                {maximized ? <MinimizeIcon /> : <MaximizeIcon />}
              </Button>
              <DialogCloseButton />
            </DialogTitleBar>
            <div
              className={cn(
                "min-h-0 overflow-auto",
                maximized ? "flex-1" : "max-h-[75vh]",
              )}
            >
              {pair !== undefined ? (
                <CompareCanvas
                  key={
                    pair.kind === "diagram"
                      ? pair.key
                      : `${pair.before.src} ${pair.after.src}`
                  }
                  pair={pair}
                  maximized={maximized}
                  toolbar={toolbar}
                  lastHeight={imageHeight}
                  held={held}
                  dialog={dialog}
                  widening={widening}
                  cut={cut}
                  onCut={setCut}
                  fade={fade}
                />
              ) : diagram !== undefined ? (
                <DiagramCanvas
                  key={diagram.key}
                  view={diagram}
                  maximized={maximized}
                  toolbar={toolbar}
                  lastHeight={imageHeight}
                  held={held}
                  dialog={dialog}
                  widening={widening}
                />
              ) : target === undefined ? null : kind === "image" ? (
                <ImageCanvas
                  key={target.url}
                  src={target.url}
                  alt={target.filename}
                  maximized={maximized}
                  toolbar={toolbar}
                  lastHeight={imageHeight}
                  held={held}
                  dialog={dialog}
                  widening={widening}
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
                  key={target.url}
                  target={target}
                  slug={slug}
                  issueNumber={issueNumber}
                  toolbar={toolbar}
                />
              ) : (
                <DownloadOnlyPane target={target} />
              )}
            </div>
            {pair !== undefined && (
              <>
                <CompareBar pair={pair} fade={fade} onFade={setFade} />
                {pair.kind === "diagram" ? (
                  <DiagramFooter
                    diagramType={pair.diagramType}
                    sources={[
                      { side: "before", ...pair.before },
                      { side: "after", ...pair.after },
                    ]}
                  />
                ) : (
                  <CompareFooter pair={pair} />
                )}
              </>
            )}
            {diagram !== undefined && (
              <DiagramFooter
                diagramType={diagram.diagramType}
                sources={[{ source: diagram.source }]}
              />
            )}
            {target !== undefined && (
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
                  {tabHref !== null && (
                    <a
                      href={tabHref}
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
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A comparison's footer: the new side's type and both sizes, and each side
 * to download. No new tab: the comparison is the thing being looked at.
 */
function CompareFooter({ pair }: { pair: ImagePair }) {
  const { before, after } = pair;
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span className="truncate">
        {[
          after.contentType,
          before.bytes !== undefined && after.bytes !== undefined
            ? `${formatSize(before.bytes)} → ${formatSize(after.bytes)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        {(["before", "after"] as const).map((which) => (
          <a
            key={which}
            href={pair[which].src}
            download={pair[which].filename}
            data-side={which}
            aria-label={`Download ${pair[which].label}`}
            className="compare-viewer-download inline-flex items-center gap-1 font-medium hover:underline"
          >
            <span className="media-compare-tick" />
            <DownloadIcon className="size-3.5" />
            {pair[which].label}
          </a>
        ))}
      </span>
    </div>
  );
}

/**
 * A diagram's footer: its type, and its mermaid source to copy — each side's
 * in a comparison. No download: an SVG file away from the page's font is not
 * a faithful copy of what is drawn here.
 */
function DiagramFooter({
  diagramType,
  sources,
}: {
  diagramType: string;
  /** A lone diagram's has no side. */
  sources: Array<{ side?: "before" | "after"; label?: string; source: string }>;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span className="truncate">mermaid · {diagramType}</span>
      <span className="flex shrink-0 items-center gap-3">
        {sources.map((source) => (
          <CopySource key={source.side ?? "source"} {...source} />
        ))}
      </span>
    </div>
  );
}

const COPIED_MS = 1500;

/** As the fence's Copy: a check for a moment, failure toasting. */
function CopySource({
  side,
  label,
  source,
}: {
  side?: "before" | "after";
  label?: string;
  source: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = label === undefined ? "Copy source" : `Copy ${label} source`;
  return (
    <button
      type="button"
      data-side={side}
      aria-label={name}
      onClick={async () => {
        if (!(await writeClipboard(source))) return;
        clearTimeout(timer.current);
        setCopied(true);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }}
      className="compare-viewer-download inline-flex cursor-pointer items-center gap-1 font-medium hover:underline"
    >
      {side !== undefined && <span className="media-compare-tick" />}
      {copied ? (
        <CheckIcon className="size-3.5" data-icon="copied" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      {label === undefined ? "Copy source" : `${label} source`}
    </button>
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
