import { formatAnchorRange } from "@todou/shared";
import { FileTextIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { MarkdownEditor } from "@/components/shared/markdown-editor.tsx";
import { Button } from "@/components/ui/button";

/** Longest quote preview before the rest folds into a "+N lines" note. */
const QUOTE_PREVIEW_LINES = 4;

export type ComposerStaging = {
  path: string;
  version: number;
  /** Null = file-level comment (T-61). */
  lineStart: number | null;
  lineEnd: number | null;
  /** Null = the whole lines, as every pre-T-142 anchor means. */
  colStart: number | null;
  colEnd: number | null;
  quote: string;
};

/**
 * Comment-composer-style bottom strip for staging a spec comment (T-61) —
 * a sticky in-flow panel like the issue page's composer, never a modal:
 * the document stays visible and scrollable while writing. Key it by the
 * anchor so a new selection starts with an empty body.
 */
export function SpecComposer({
  staging,
  onCancel,
  onStage,
}: {
  staging: ComposerStaging;
  onCancel: () => void;
  onStage: (body: string) => void;
}) {
  const [body, setBody] = useState("");
  const fileLevel = staging.lineStart === null;
  const lines = fileLevel
    ? "file comment"
    : formatAnchorRange({
        line_start: staging.lineStart,
        line_end: staging.lineEnd,
        col_start: staging.colStart,
        col_end: staging.colEnd,
      });
  const quoteLines = staging.quote === "" ? [] : staging.quote.split("\n");
  const shown = quoteLines.slice(0, QUOTE_PREVIEW_LINES);
  const hidden = quoteLines.length - shown.length;

  return (
    <div className="sticky bottom-0 z-10 bg-background pt-2 pb-3">
      <div className="rounded-lg border shadow-lg">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{staging.path}</span>
          <span className="shrink-0">
            {lines} · v{staging.version}
          </span>
          <span className="ml-auto" />
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6"
            aria-label="cancel comment"
            onClick={onCancel}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
        {shown.length > 0 && (
          <div className="border-b border-l-2 border-l-primary bg-muted/30 px-3 py-1.5 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {shown.join("\n")}
            {hidden > 0 && (
              <div className="pt-0.5 text-[11px] italic">
                … +{hidden} more line{hidden === 1 ? "" : "s"}
              </div>
            )}
          </div>
        )}
        <div className="space-y-2 p-2">
          <MarkdownEditor
            autoFocus
            ariaLabel="Spec comment"
            className="min-h-16"
            onChange={setBody}
            placeholder={
              fileLevel
                ? "Comment on this file (markdown)… staged locally until you finish the review"
                : "Comment (markdown)… staged locally until you finish the review"
            }
            onCancel={onCancel}
            onSubmit={(value) => {
              if (value.trim() !== "") onStage(value);
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              ⌘↵ to stage · esc to cancel
            </span>
            <span className="ml-auto" />
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={body.trim() === ""}
              onClick={() => onStage(body)}
            >
              Stage comment
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
