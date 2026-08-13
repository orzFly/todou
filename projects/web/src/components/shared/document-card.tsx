import {
  DownloadIcon,
  FileCode2Icon,
  FileTextIcon,
  Maximize2Icon,
  MaximizeIcon,
  MinimizeIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MarkdownView } from "@/components/shared/markdown-view.tsx";
import { CodeBlock } from "@/components/shared/pierre.tsx";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type DocumentRender = "markdown" | "code";

export function documentRenderKind(filename: string): DocumentRender {
  return /\.(md|markdown)$/i.test(filename) ? "markdown" : "code";
}

/**
 * One text document, rendered the way its filename asks: markdown through
 * our own MarkdownView, everything else through pierre CodeBlock. Markdown
 * is always rendered in embedded mode — a document that references other
 * documents shows them as links, which is what breaks the cycle when a
 * document (transitively) embeds itself.
 */
export function DocumentView({
  filename,
  text,
  render = documentRenderKind(filename),
  slug,
  issueNumber,
  refDate,
}: {
  filename: string;
  text: string;
  /** Override the filename-based markdown/code choice. */
  render?: DocumentRender;
  /** Markdown context (issue refs, attachment refs); omit outside a project. */
  slug?: string;
  issueNumber?: number;
  /** The document's creation time (T-80 time cutoff for issue refs). */
  refDate?: string;
}) {
  if (render === "markdown") {
    return (
      <MarkdownView
        slug={slug}
        issueNumber={issueNumber}
        refDate={refDate}
        embedded
      >
        {text}
      </MarkdownView>
    );
  }
  return <CodeBlock filename={filename} contents={text} lineNumbers />;
}

/**
 * Inline document embed: bordered card with a filename header and a
 * height-capped body, expanding to the full document in a dialog. Built
 * for text/markdown attachment embeds, generic on purpose — T-23 renders
 * spec files through the same card (pass `text` directly, put version
 * chips or review state into `headerActions`).
 */
export function DocumentCard({
  filename,
  text,
  render,
  slug,
  issueNumber,
  refDate,
  meta,
  headerActions,
  downloadUrl,
  className,
  collapsedClassName = "max-h-80",
}: {
  filename: string;
  text: string;
  render?: DocumentRender;
  slug?: string;
  issueNumber?: number;
  refDate?: string;
  /** Short muted note next to the filename (e.g. a size). */
  meta?: string;
  /** Extra header controls, rendered before download/expand. */
  headerActions?: ReactNode;
  downloadUrl?: string;
  className?: string;
  /** Height cap for the collapsed body. */
  collapsedClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  // The cap sits on the outer box, so growth of the inner content (lazy
  // CodeBlock upgrade, images loading) never resizes the observed border
  // box — observe the inner one.
  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (outer === null || inner === null) return;
    const check = () =>
      setOverflowing(inner.offsetHeight > outer.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const resolvedRender = render ?? documentRenderKind(filename);
  const Icon = resolvedRender === "markdown" ? FileTextIcon : FileCode2Icon;

  return (
    <section
      className={cn("my-2 overflow-hidden rounded-lg border", className)}
    >
      <div className="flex items-center gap-1 border-b bg-muted/40 py-1 pr-1.5 pl-3 text-sm">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium hover:underline">
            {filename}
          </span>
          {meta !== undefined && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {meta}
            </span>
          )}
        </button>
        {headerActions}
        {downloadUrl !== undefined && (
          <a
            href={downloadUrl}
            download={filename}
            aria-label={`download ${filename}`}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <DownloadIcon className="size-3.5" />
          </a>
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`expand ${filename}`}
          className="cursor-pointer rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Maximize2Icon className="size-3.5" />
        </button>
      </div>
      <div
        ref={outerRef}
        className={cn("relative overflow-hidden", collapsedClassName)}
      >
        <div ref={innerRef} className="p-3">
          <DocumentView
            filename={filename}
            text={text}
            render={resolvedRender}
            slug={slug}
            issueNumber={issueNumber}
            refDate={refDate}
          />
        </div>
        {overflowing && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="absolute inset-x-0 bottom-0 flex h-16 cursor-pointer items-end justify-center bg-gradient-to-t from-background to-transparent pb-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Show full document
          </button>
        )}
      </div>
      <Dialog
        open={expanded}
        onOpenChange={(open) => {
          if (!open) {
            setExpanded(false);
            setMaximized(false);
          }
        }}
      >
        <DialogContent
          className={cn(
            "flex flex-col bg-background",
            // Maximized: fill the viewport (clearing the centering
            // translate) but stay a modal — Esc still closes it.
            // sm:max-w-none beats the dialog's built-in sm:max-w-sm cap.
            maximized
              ? "top-0 left-0 h-full w-full max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
              : "sm:max-w-4xl",
          )}
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-1 pr-8">
            <DialogTitle className="min-w-0 flex-1 truncate">
              {filename}
            </DialogTitle>
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
            <DocumentView
              filename={filename}
              text={text}
              render={resolvedRender}
              slug={slug}
              issueNumber={issueNumber}
              refDate={refDate}
            />
          </div>
          {(meta !== undefined || downloadUrl !== undefined) && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{meta}</span>
              {downloadUrl !== undefined && (
                <a
                  href={downloadUrl}
                  download={filename}
                  className="inline-flex items-center gap-1 font-medium hover:underline"
                >
                  <DownloadIcon className="size-3.5" />
                  Download
                </a>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
