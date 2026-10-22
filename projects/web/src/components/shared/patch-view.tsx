import type { FileDiffMetadata, ParsedPatch } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  CodeBlock,
  PatchFiles,
  PlainCodeFallback,
  parsePatch,
  patchFileId,
} from "@/components/shared/pierre.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils";

type Parsed =
  | { kind: "pending" }
  | { kind: "patch"; patches: ParsedPatch[] }
  | { kind: "invalid" }
  // The parser's chunk never arrived (offline): nothing is known about the
  // text, so it is not called invalid.
  | { kind: "unavailable" };

function countLines(file: FileDiffMetadata): { plus: number; minus: number } {
  let plus = 0;
  let minus = 0;
  for (const hunk of file.hunks) {
    plus += hunk.additionLines;
    minus += hunk.deletionLines;
  }
  return { plus, minus };
}

function Counts({ plus, minus }: { plus: number; minus: number }) {
  return (
    <span className="shrink-0 space-x-1 font-mono tabular-nums">
      {plus > 0 && <span className="diff-addition-text">+{plus}</span>}
      {minus > 0 && <span className="diff-deletion-text">−{minus}</span>}
    </span>
  );
}

function fileLabel(file: FileDiffMetadata): string {
  return file.prevName !== undefined && file.prevName !== file.name
    ? `${file.prevName} → ${file.name}`
    : file.name;
}

/**
 * A unified diff drawn as one diff per file (T-528), with a Raw toggle back to
 * the text as written. Text that does not parse cleanly stays that text: see
 * `parsePatch` for why a half-parsed patch is never drawn.
 */
export function PatchView({
  filename,
  text,
  lineNumbers = false,
  invalidNote = false,
  clipped = false,
}: {
  /** Names the raw view's highlighting. */
  filename: string;
  text: string;
  /** Line numbers on the raw view, as whole files have them. */
  lineNumbers?: boolean;
  /**
   * Say so when the text is not a patch. An attachment named .patch promised
   * one; a ```diff fence holding a bare +/- snippet never did.
   */
  invalidNote?: boolean;
  /**
   * Sits in a box that hides its overflow (a collapsed card): the diffs stop
   * at that box's height instead of scrolling, and the file list does not
   * jump, since nothing the reader can do would scroll back.
   */
  clipped?: boolean;
}) {
  const [parsed, setParsed] = useState<Parsed>({ kind: "pending" });
  const [raw, setRaw] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const view = useRef<CodeViewHandle<undefined>>(null);

  useEffect(() => {
    let live = true;
    setParsed({ kind: "pending" });
    // A fence body arrives without its last newline. The patch's own
    // "\ No newline at end of file" markers carry that fact, not this one.
    parsePatch(text.endsWith("\n") ? text : `${text}\n`).then(
      (patches) => {
        if (live) {
          setParsed(
            patches === null ? { kind: "invalid" } : { kind: "patch", patches },
          );
        }
      },
      () => {
        if (live) setParsed({ kind: "unavailable" });
      },
    );
    return () => {
      live = false;
    };
  }, [text]);

  if (parsed.kind === "pending") return <PlainCodeFallback contents={text} />;
  if (parsed.kind !== "patch") {
    return (
      <>
        {parsed.kind === "invalid" && invalidNote && (
          <p className="mb-2 text-xs text-muted-foreground">
            Not a valid patch — showing the text.
          </p>
        )}
        <CodeBlock
          filename={filename}
          contents={text}
          lineNumbers={lineNumbers}
        />
      </>
    );
  }

  const files = parsed.patches.flatMap((patch) => patch.files);
  const stats = files.map(countLines);
  const jump = (index: number) =>
    view.current?.scrollTo({
      type: "item",
      id: patchFileId(index),
      align: "start",
    });

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        {files.length > 1 && !raw && (
          <button
            type="button"
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
            className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                listOpen && "rotate-90",
              )}
            />
            {files.length} files
            <Counts
              plus={stats.reduce((sum, s) => sum + s.plus, 0)}
              minus={stats.reduce((sum, s) => sum + s.minus, 0)}
            />
          </button>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="ml-auto"
          aria-pressed={raw}
          onClick={() => setRaw((shown) => !shown)}
        >
          {raw ? "Diff" : "Raw"}
        </Button>
      </div>
      {raw ? (
        <CodeBlock
          filename={filename}
          contents={text}
          lineNumbers={lineNumbers}
        />
      ) : (
        <>
          {listOpen && files.length > 1 && (
            <ul className="mb-3 max-h-48 divide-y overflow-y-auto rounded-md border text-xs">
              {files.map((file, index) => {
                const row = (
                  <>
                    <span className="min-w-0 truncate font-mono">
                      {fileLabel(file)}
                    </span>
                    <Counts {...stats[index]} />
                  </>
                );
                const rowClass =
                  "flex w-full items-center justify-between gap-3 px-2.5 py-1";
                return (
                  // Two entries may name one file (a multi-commit patch);
                  // the position is what tells them apart.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <li key={index}>
                    {!clipped ? (
                      <button
                        type="button"
                        onClick={() => jump(index)}
                        className={cn(
                          rowClass,
                          "cursor-pointer text-left hover:bg-muted",
                        )}
                      >
                        {row}
                      </button>
                    ) : (
                      <div className={rowClass}>{row}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <PatchFiles
            patches={parsed.patches}
            text={text}
            viewRef={view}
            className={
              clipped
                ? "max-h-80 overflow-hidden"
                : "max-h-[70vh] overflow-auto"
            }
          />
        </>
      )}
    </div>
  );
}
