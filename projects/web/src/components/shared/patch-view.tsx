import type {
  CodeViewItem,
  FileDiffMetadata,
  ParsedPatch,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import {
  ChevronDownIcon,
  CodeIcon,
  FileDiffIcon,
  GitCommitHorizontalIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CodeBlock,
  PATCH_HEADER_HEIGHT,
  PatchFiles,
  PlainCodeFallback,
  parsePatch,
  patchCommitId,
  patchFileId,
} from "@/components/shared/pierre.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import {
  formatCommitDate,
  type PatchCommit,
  parsePatchCommit,
} from "@/lib/patch-commit.ts";
import { cn } from "@/lib/utils";

type Parsed =
  | { kind: "pending" }
  | { kind: "patch"; patches: ParsedPatch[] }
  | { kind: "invalid" }
  // The parser's chunk never arrived (offline): nothing is known about the
  // text, so it is not called invalid.
  | { kind: "unavailable" };

type Stat = { plus: number; minus: number };

function countLines(file: FileDiffMetadata): Stat {
  let plus = 0;
  let minus = 0;
  for (const hunk of file.hunks) {
    plus += hunk.additionLines;
    minus += hunk.deletionLines;
  }
  return { plus, minus };
}

function Counts({ plus, minus }: Stat) {
  return (
    <span className="shrink-0 space-x-1 font-mono text-xs tabular-nums">
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

const HEADER_ROW = "flex min-w-0 items-center gap-2 px-3 text-sm";

function CommitHeader({ commit }: { commit: PatchCommit }) {
  const byline = [
    commit.author,
    commit.date === undefined ? undefined : formatCommitDate(commit.date),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={HEADER_ROW} style={{ height: PATCH_HEADER_HEIGHT }}>
      <GitCommitHorizontalIcon className="size-4 shrink-0 text-muted-foreground" />
      {commit.series !== undefined && (
        <span className="shrink-0 rounded-full border px-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums">
          {commit.series}
        </span>
      )}
      <span className="min-w-0 truncate font-medium" title={commit.subject}>
        {commit.subject === "" ? "Message" : commit.subject}
      </span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {byline}
        {commit.hash !== undefined && (
          <span className="ml-2 font-mono">{commit.hash.slice(0, 7)}</span>
        )}
      </span>
    </div>
  );
}

function FileHeader({ file, stat }: { file: FileDiffMetadata; stat: Stat }) {
  const label = fileLabel(file);
  return (
    <div className={HEADER_ROW} style={{ height: PATCH_HEADER_HEIGHT }}>
      <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-mono text-[0.8rem]" title={label}>
        {label}
      </span>
      <span className="ml-auto">
        <Counts {...stat} />
      </span>
    </div>
  );
}

function FileList({
  files,
  stats,
  onJump,
}: {
  files: FileDiffMetadata[];
  stats: Stat[];
  /** Absent where nothing could scroll to the file. */
  onJump?: (index: number) => void;
}) {
  return (
    <ul className="divide-y text-xs">
      {files.map((file, index) => {
        // A long path gives up its directories, never the file's own name.
        const slash = file.name.lastIndexOf("/");
        const row = (
          <>
            <span className="flex min-w-0 font-mono">
              <span className="min-w-0 truncate text-muted-foreground">
                {file.name.slice(0, slash + 1)}
              </span>
              <span className="shrink-0">{file.name.slice(slash + 1)}</span>
            </span>
            <Counts {...stats[index]} />
          </>
        );
        const rowClass =
          "flex w-full items-center justify-between gap-3 px-2.5 py-1.5";
        return (
          // Two entries may name one file (a multi-commit patch); the
          // position is what tells them apart.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={index} title={fileLabel(file)}>
            {onJump !== undefined ? (
              <button
                type="button"
                onClick={() => onJump(index)}
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
  );
}

function FilesMenu({
  files,
  stats,
  onJump,
}: {
  files: FileDiffMetadata[];
  stats: Stat[];
  onJump?: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const total = stats.reduce(
    (sum, s) => ({ plus: sum.plus + s.plus, minus: sum.minus + s.minus }),
    { plus: 0, minus: 0 },
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="font-normal text-muted-foreground"
        >
          <span className="tabular-nums">{files.length} files</span>
          <Counts {...total} />
          <ChevronDownIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[55vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
      >
        <FileList
          files={files}
          stats={stats}
          onJump={
            onJump === undefined
              ? undefined
              : (index) => {
                  setOpen(false);
                  onJump(index);
                }
          }
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A unified diff drawn as one diff per file (T-528), each commit's message
 * above its files. The file list and the way back to the text as written are
 * controls of the surface around it (T-529): a card or dialog hands over a
 * spot in its title bar, and a fence, which has none, gets a frame with one.
 * Text that does not parse cleanly stays that text: see `parsePatch` for why
 * a half-parsed patch is never drawn.
 */
export function PatchView({
  filename,
  text,
  lineNumbers = false,
  invalidNote = false,
  clipped = false,
  toolbar,
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
  /**
   * Where the surrounding title bar takes the controls; null until it has
   * mounted. Omitted, the patch draws a title bar of its own.
   */
  toolbar?: HTMLElement | null;
}) {
  const [parsed, setParsed] = useState<Parsed>({ kind: "pending" });
  const [raw, setRaw] = useState(false);
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

  const patches = parsed.kind === "patch" ? parsed.patches : null;
  const drawn = useMemo(() => {
    if (patches === null) return null;
    const files = patches.flatMap((patch) => patch.files);
    const stats = files.map(countLines);
    const commits = patches.map((patch) =>
      parsePatchCommit(patch.patchMetadata ?? ""),
    );
    const headers = new Map<string, ReactNode>();
    commits.forEach((commit, index) => {
      if (commit !== null) {
        headers.set(patchCommitId(index), <CommitHeader commit={commit} />);
      }
    });
    files.forEach((file, index) => {
      headers.set(
        patchFileId(index),
        <FileHeader file={file} stat={stats[index]} />,
      );
    });
    return { files, stats, commits, headers };
  }, [patches]);

  if (parsed.kind === "pending") return <PlainCodeFallback contents={text} />;
  if (patches === null || drawn === null) {
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

  const { files, stats, commits, headers } = drawn;
  const controls = (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {files.length > 1 && !raw && (
        <FilesMenu
          files={files}
          stats={stats}
          onJump={
            clipped
              ? undefined
              : (index) =>
                  view.current?.scrollTo({
                    type: "item",
                    id: patchFileId(index),
                    align: "start",
                  })
          }
        />
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-pressed={raw}
        title={raw ? "Back to the diff" : "The patch as written"}
        className={cn(
          "font-normal text-muted-foreground",
          raw && "bg-muted text-foreground",
        )}
        onClick={() => setRaw((shown) => !shown)}
      >
        <CodeIcon />
        raw
      </Button>
    </span>
  );
  const body = raw ? (
    <CodeBlock filename={filename} contents={text} lineNumbers={lineNumbers} />
  ) : (
    <PatchFiles
      patches={patches}
      commits={commits}
      text={text}
      viewRef={view}
      renderHeader={(item: CodeViewItem) => headers.get(item.id)}
      className={
        clipped ? "max-h-80 overflow-hidden" : "max-h-[70vh] overflow-auto"
      }
    />
  );

  if (toolbar !== undefined) {
    return (
      <>
        {toolbar !== null && createPortal(controls, toolbar)}
        {body}
      </>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b bg-muted/40 py-1 pr-1.5 pl-3 text-xs text-muted-foreground">
        <FileDiffIcon className="size-3.5" />
        <span>patch</span>
        <span className="ml-auto" />
        {controls}
      </div>
      <div className="p-2">{body}</div>
    </div>
  );
}
