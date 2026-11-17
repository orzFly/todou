import {
  CheckIcon,
  CopyIcon,
  FileCode2Icon,
  FoldVerticalIcon,
  UnfoldVerticalIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { writeClipboard } from "@/lib/clipboard.ts";
import { cn } from "@/lib/utils";

const COPIED_MS = 1500;

/**
 * Copies `text` and answers on the button itself — a check for a moment, and
 * "Copied" for a screen reader — rather than with a toast: the reader's eyes
 * are already on it. Failure still toasts, from `writeClipboard`.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Copy"
        title="Copy"
        className="text-muted-foreground"
        onClick={async () => {
          if (!(await writeClipboard(text))) return;
          clearTimeout(timer.current);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        }}
      >
        {copied ? (
          <CheckIcon className="size-3.5" data-icon="copied" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/**
 * The block's text as a file named `title`. A blob URL rather than data:,
 * because a same-origin blob can be opened top-level in a new tab and data:
 * cannot. Made in an effect, not a memo: StrictMode's remount would run the
 * cleanup and revoke a memoized URL that the second mount still renders.
 */
export function FenceTitleLink({
  title,
  text,
}: {
  title: string;
  text: string;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [text]);
  return (
    <a
      href={url}
      download={title}
      title={title}
      className="fence-title-link group flex min-w-0 items-center gap-1.5 text-foreground"
    >
      <FileCode2Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs group-hover:underline">
        {title}
      </span>
    </a>
  );
}

/**
 * A code block's frame (T-706): a border, copy, and either the fence's
 * language in a toolbar that shows on hover or, when the fence names a file,
 * a standing header whose name downloads it. The content area is the
 * children's alone — no padding, no background — so a diagram, a diff or an
 * image comparison can sit in it on its own terms.
 */
export function FenceFrame({
  text,
  lang,
  title,
  leading,
  collapsible = false,
  toolbarAlwaysVisible = false,
  actions,
  children,
}: {
  /** What Copy and the download hand over: the fence as written. Without it, no Copy. */
  text?: string;
  /** Shown in the floating toolbar; a header's filename says it instead. */
  lang?: string;
  /** A filename: draws the header in place of the floating toolbar. */
  title?: string;
  /**
   * Controls at the head's left edge; draws the header as `title` does. A
   * floating toolbar would sit on the corner of whatever the frame shows.
   */
  leading?: ReactNode;
  /** Caps the height to scroll inside the frame, with Expand to lift it. */
  collapsible?: boolean;
  /** For a toolbar that is the only way to reach something, as a diagram's. */
  toolbarAlwaysVisible?: boolean;
  /** More controls, left of Expand and Copy. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const controls = (
    <>
      {actions}
      {collapsible && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={expanded ? "Collapse" : "Expand"}
          title={expanded ? "Collapse" : "Expand"}
          aria-pressed={expanded}
          className="text-muted-foreground"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? (
            <FoldVerticalIcon className="size-3.5" />
          ) : (
            <UnfoldVerticalIcon className="size-3.5" />
          )}
        </Button>
      )}
      {text !== undefined && <CopyButton text={text} />}
    </>
  );
  return (
    <div className="fence-frame relative overflow-clip rounded-lg border">
      {title !== undefined || leading !== undefined ? (
        <div
          className={cn(
            "fence-head flex min-h-[34px] items-center gap-1 rounded-t-lg border-b bg-muted/40 py-0.5 pr-1 select-none",
            leading !== undefined ? "pl-2" : "pl-3",
          )}
        >
          {leading}
          {title !== undefined &&
            (text !== undefined ? (
              <FenceTitleLink title={title} text={text} />
            ) : (
              <span className="truncate font-mono text-xs">{title}</span>
            ))}
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {controls}
          </span>
        </div>
      ) : (
        // In the flow, not floating over the code: on touch it never hides,
        // and anywhere it would cover the end of a long first line. It
        // reaches down into the content's own top padding to cost less
        // height — but not over a scroller, whose lines would pass under it.
        <div
          className={cn(
            "fence-tools relative z-10 mt-1 mr-1 ml-auto flex w-fit items-center gap-0.5 rounded-md border bg-background/90 p-px shadow-xs select-none",
            !collapsible && "-mb-3",
          )}
          data-always={toolbarAlwaysVisible ? "" : undefined}
        >
          {lang !== undefined && lang !== "" && (
            <span className="px-1.5 font-mono text-[11px] text-muted-foreground">
              {lang}
            </span>
          )}
          {controls}
        </div>
      )}
      {collapsible ? (
        // Capped here rather than through pierre's className: pierre only
        // virtualizes against its own box, so every line stays in the DOM and
        // find-in-page still scrolls this box to a hit past the cap.
        <section
          className="fence-scroll"
          // A scrollable box has to be focusable for the keyboard to scroll it.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
          tabIndex={0}
          aria-label="Code"
          data-expanded={expanded ? "" : undefined}
        >
          {children}
        </section>
      ) : (
        children
      )}
    </div>
  );
}
