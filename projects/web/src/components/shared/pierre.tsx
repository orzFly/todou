import type { CodeViewItem, ParsedPatch } from "@pierre/diffs";
import type {
  CodeViewHandle,
  CodeViewProps,
  MultiFileDiffProps,
} from "@pierre/diffs/react";
import {
  Component,
  type ComponentType,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PatchCommit } from "@/lib/patch-commit.ts";
import { syntaxThemeOf, type ThemePref, useThemePref } from "@/lib/theme.ts";

type Chunk<P> =
  | { status: "loaded"; Component: ComponentType<P> }
  | { status: "failed"; error: unknown };

/**
 * A component fetched in its own chunk on first render, drawing `fallback`
 * until it arrives.
 *
 * Not `lazy()`, because suspending here throws away far more than the code
 * block (T-600). On a page's first load the nearest boundary that has never
 * shown its content is the shell's, and React will not commit a retry that
 * suspends within 300 ms of that boundary's fallback: when the chunk lands it
 * renders the whole page again from scratch. Every component above the
 * block, and the spec document's whole-file markdown parse, ran twice.
 *
 * Not `useSyncExternalStore` either, for the same reason: a store that
 * changes while a concurrent render is yielding fails React's consistency
 * check, and the whole render is redone synchronously. The chunk landing
 * mid-render is exactly that change.
 */
function chunkComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P & { fallback?: ReactNode }> {
  let chunk: Chunk<P> | undefined;
  let settled: Promise<Chunk<P>> | undefined;
  const start = () => {
    settled ??= load().then(
      (Component) => (chunk = { status: "loaded", Component }),
      (error: unknown) => (chunk = { status: "failed", error }),
    );
    return settled;
  };
  return function ChunkComponent({
    fallback = null,
    ...props
  }: P & { fallback?: ReactNode }) {
    const [current, setCurrent] = useState(chunk);
    const waiting = current === undefined;
    // Started from render, as lazy() does, so the fetch is not held back
    // until the page commits.
    if (waiting) start();
    useEffect(() => {
      if (!waiting) return;
      let live = true;
      start().then((next) => {
        if (live) setCurrent(next);
      });
      return () => {
        live = false;
      };
    }, [waiting]);
    // Rethrown as lazy() would, so CodeViewBoundary still turns a chunk that
    // never arrives (offline) into plain text.
    if (current?.status === "failed") throw current.error;
    if (current?.status !== "loaded") return fallback;
    return <current.Component {...(props as P)} />;
  };
}

// @pierre/diffs is the heaviest dependency in the web bundle (T-24). Every
// value import goes through chunkComponent() here so the library lands in its
// own chunk, fetched the first time a code surface actually renders; the rest
// of the app must only use type imports.
const ChunkCodeView = chunkComponent(() =>
  import("@pierre/diffs/react").then(
    (m) =>
      m.CodeView as ComponentType<
        CodeViewProps & { ref?: Ref<CodeViewHandle<undefined>> }
      >,
  ),
);

/**
 * CodeView with its tokenizing moved into pierre's worker pool (T-584). pierre
 * tokenizes the whole file even when only a screenful of lines is drawn: 1 MiB
 * of log held the tab for 9.3 s on the main thread, 0.2 s with the worker.
 * The lines show as plain text at once, and their colours follow.
 *
 * The pool is a page-wide singleton that the last provider to unmount
 * terminates, so it only exists while an attachment is on screen.
 */
const ChunkWorkerCodeView = chunkComponent(() =>
  Promise.all([
    import("@pierre/diffs/react"),
    import("@pierre/diffs/worker/worker.js?worker"),
  ]).then(([m, { default: PierreWorker }]) => {
    const CodeView = m.CodeView as ComponentType<CodeViewProps>;
    // The pool keeps the theme it was created with and overrides each
    // view's own; a theme switch while it lives has to reach it here.
    function ThemeSync({ theme }: { theme: SyntaxTheme }) {
      const pool = m.useWorkerPool();
      useEffect(() => {
        pool?.setRenderOptions({ theme }).catch(() => {});
      }, [pool, theme]);
      return null;
    }
    function WorkerCodeView(props: CodeViewProps) {
      const theme = useSyntaxTheme();
      const [poolOptions] = useState(() => ({
        workerFactory: () => new PierreWorker(),
        // One file is open at a time; each worker loads its own highlighter.
        poolSize: 2,
      }));
      const [highlighterOptions] = useState(() => ({
        theme,
        preferredHighlighter: PIERRE_HIGHLIGHTER,
      }));
      return (
        <m.WorkerPoolContextProvider
          poolOptions={poolOptions}
          highlighterOptions={highlighterOptions}
        >
          <ThemeSync theme={theme} />
          <CodeView {...props} />
        </m.WorkerPoolContextProvider>
      );
    }
    return WorkerCodeView;
  }),
);

export const ChunkMultiFileDiff = chunkComponent(() =>
  import("@pierre/diffs/react").then(
    (m) => m.MultiFileDiff as ComponentType<MultiFileDiffProps<undefined>>,
  ),
);

/**
 * A unified diff split into commits and their files, or null when the text is
 * not one. Strict on purpose (T-528): pierre's lenient mode skips a hunk whose
 * counts do not add up and carries on, so the reader would be shown a patch
 * with a change silently missing. Text before the first file — a commit
 * message — is no reason to refuse; a patch with no file in it is.
 */
export async function parsePatch(text: string): Promise<ParsedPatch[] | null> {
  const { parsePatchFiles } = await import("@pierre/diffs");
  try {
    const patches = parsePatchFiles(text, undefined, true);
    return patches.some((patch) => patch.files.length > 0) ? patches : null;
  } catch {
    return null;
  }
}

export const PIERRE_THEME = {
  dark: "pierre-dark",
  light: "pierre-light",
} as const;

/**
 * "system" makes pierre inject no color-scheme pin of its own; the actual
 * scheme is forced from the outer tree by the `diffs-container` rules in
 * styles.css, which follow the app theme (T-36). Options objects that
 * captured this value at module scope stay correct for the same reason.
 */
export const PIERRE_THEME_TYPE = "system" as const;

export type SyntaxTheme = { light: string; dark: string };

// Keyed by preference, so every surface on the page hands pierre the same
// object identity across renders (props-stability guidance below).
const SYNTAX_THEMES = new Map<ThemePref, SyntaxTheme>();

/**
 * Syntax token colors for the active theme (T-144). Under "system" the pair
 * stays pierre's own, because the light/dark choice is then made by CSS
 * light-dark() inside the shadow root rather than by a React render. A named
 * theme resolves to one shiki theme in both slots: its kind is fixed, so the
 * slot the browser will not paint is irrelevant.
 */
export function useSyntaxTheme(): SyntaxTheme {
  const pref = useThemePref();
  const cached = SYNTAX_THEMES.get(pref);
  if (cached) return cached;
  const syntax = pref === "system" ? undefined : syntaxThemeOf(pref);
  const resolved: SyntaxTheme =
    syntax === undefined ? PIERRE_THEME : { light: syntax, dark: syntax };
  SYNTAX_THEMES.set(pref, resolved);
  return resolved;
}

/** The shape every code surface falls back to: the code, unhighlighted. */
export function PlainCodeFallback({ contents }: { contents: string }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.85em] leading-[1.45]">
      <code>{contents}</code>
    </pre>
  );
}

// Keyed by the div CodeView renders into, so the module-level onPostRender
// below can find which block a failed <diffs-container> belongs to. A WeakMap
// because the entry is only ever reachable through a live node.
const DEGRADE_HANDLERS = new WeakMap<Element, () => void>();
// Options are cached at module scope; readiness belongs to the mounted block,
// just like degradation, rather than to a closure in an options object.
const READY_HANDLERS = new WeakMap<Element, () => void>();

/**
 * pierre's own posture on a highlighter failure is to paint the exception
 * message and its JS stack into the shadow root and carry on, which puts a
 * stack trace where the reader expects code (T-177). An ErrorBoundary cannot
 * take that over: the failing render happens partly on an async path, where a
 * rethrow would only become an unhandled rejection and leave the block blank.
 * `emitPostRender` does run right after the error is painted, in the same
 * task, so spotting the wrapper here swaps in plain text before the next
 * paint — the stack never reaches the screen.
 */
function handlePostRender(container: HTMLElement): void {
  const shadow = container.shadowRoot;
  if (shadow?.querySelector("[data-error-wrapper]") != null) {
    for (
      let node: Element | null = container;
      node;
      node = node.parentElement
    ) {
      const degrade = DEGRADE_HANDLERS.get(node);
      if (degrade !== undefined) {
        degrade();
        return;
      }
    }
  }
  if (shadow?.querySelector("[data-line]") != null) {
    for (
      let node: Element | null = container;
      node;
      node = node.parentElement
    ) {
      const ready = READY_HANDLERS.get(node);
      if (ready !== undefined) {
        ready();
        return;
      }
    }
  }
}

/**
 * pierre defaults to "shiki-js", which transpiles the TextMate grammars'
 * Oniguruma patterns into native RegExp through oniguruma-to-es. That
 * transpiler is a recursive-descent pass over patterns, and the TypeScript
 * grammar's giant lookaheads overflow SpiderMonkey's much shallower stack:
 * Firefox rendered `too much recursion` in place of every ```ts block
 * (T-177). The wasm build is real Oniguruma and never runs that pass.
 *
 * pierre's highlighter is a module singleton whose engine is fixed by
 * whichever surface creates it first, so every options object in the app has
 * to name the same one — snippets, files, and the revision diff alike.
 */
export const PIERRE_HIGHLIGHTER = "shiki-wasm" as const;

// Module-scope per the library's props-stability guidance — now one object
// per theme rather than one overall, so a surface only re-renders when the
// theme it is rendered under actually changes.
const SNIPPET_OPTIONS = new Map<SyntaxTheme, CodeViewProps["options"]>();
const FILE_OPTIONS = new Map<SyntaxTheme, CodeViewProps["options"]>();
const FENCE_DIFF_OPTIONS = new Map<
  SyntaxTheme,
  MultiFileDiffProps<undefined>["options"]
>();
const PATCH_OPTIONS = new Map<SyntaxTheme, CodeViewProps["options"]>();

// The only file items in a patch view are commit messages, and a message's
// line numbers count nothing the reader can use. pierre's own
// disableLineNumbers would take them off the diffs as well.
const COMMIT_MESSAGE_CSS = `
[data-file] [data-gutter-buffer], [data-file] [data-column-number] {
  min-width: 0; padding: 0; border-right: 0;
}
[data-file] [data-column-number]::before { min-width: 0; }
[data-file] [data-line-number-content] { display: none; }
[data-file] [data-line] { min-height: 1lh; }
`;

/** px; the header rows `PatchFiles` callers draw must be exactly this tall. */
export const PATCH_HEADER_HEIGHT = 36;

function patchOptions(theme: SyntaxTheme): CodeViewProps["options"] {
  const cached = PATCH_OPTIONS.get(theme);
  if (cached) return cached;
  // The spec source diff's look, plus pierre's file header: a patch is a list
  // of files, and the header is the only place each one is named.
  const options = {
    theme,
    themeType: PIERRE_THEME_TYPE,
    diffStyle: "unified",
    overflow: "wrap",
    preferredHighlighter: PIERRE_HIGHLIGHTER,
    onPostRender: handlePostRender,
    unsafeCSS: COMMIT_MESSAGE_CSS,
    layout: { paddingTop: 0, paddingBottom: 0, gap: 8 },
    itemMetrics: { diffHeaderHeight: PATCH_HEADER_HEIGHT },
  } as const;
  PATCH_OPTIONS.set(theme, options);
  return options;
}

function snippetOptions(theme: SyntaxTheme): CodeViewProps["options"] {
  const cached = SNIPPET_OPTIONS.get(theme);
  if (cached) return cached;
  const options = {
    theme,
    themeType: PIERRE_THEME_TYPE,
    disableFileHeader: true,
    disableLineNumbers: true,
    overflow: "wrap",
    preferredHighlighter: PIERRE_HIGHLIGHTER,
    onPostRender: handlePostRender,
  } as const;
  SNIPPET_OPTIONS.set(theme, options);
  return options;
}

function fileOptions(theme: SyntaxTheme): CodeViewProps["options"] {
  const cached = FILE_OPTIONS.get(theme);
  if (cached) return cached;
  const options = {
    theme,
    themeType: PIERRE_THEME_TYPE,
    disableFileHeader: true,
    preferredHighlighter: PIERRE_HIGHLIGHTER,
    onPostRender: handlePostRender,
  } as const;
  FILE_OPTIONS.set(theme, options);
  return options;
}

function fenceDiffOptions(
  theme: SyntaxTheme,
): MultiFileDiffProps<undefined>["options"] {
  const cached = FENCE_DIFF_OPTIONS.get(theme);
  if (cached) return cached;
  const options = {
    theme,
    themeType: PIERRE_THEME_TYPE,
    disableFileHeader: true,
    // Red above green, one column. pierre's default is `split`, which puts
    // the two sides in separate columns instead of next to each other.
    diffStyle: "unified",
    overflow: "wrap",
    preferredHighlighter: PIERRE_HIGHLIGHTER,
    // Off — pierre's default — unchanged context collapses to "N unmodified
    // lines" past a single line of it. That reads well in a whole file's
    // diff and badly in a fence the reader opened the document to read: a
    // 34-line block with one edited line came out as 10 rendered lines.
    expandUnchanged: true,
    onPostRender: handlePostRender,
  } as const;
  FENCE_DIFF_OPTIONS.set(theme, options);
  return options;
}

/**
 * Catches what the shadow-DOM check cannot: a CodeView that throws during
 * React's own render, and a pierre chunk that never arrives (offline). Both
 * land on the same plain text rather than on React's error screen.
 */
class CodeViewBoundary extends Component<
  { contents: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("pierre CodeView failed; showing plain text", error);
  }

  render() {
    if (this.state.failed) {
      return <PlainCodeFallback contents={this.props.contents} />;
    }
    return this.props.children;
  }
}

// Fence tags that are language names rather than the file extensions
// pierre's filename inference knows.
const FENCE_TAG_EXTENSION: Record<string, string> = {
  python: "py",
  rust: "rs",
  typescript: "ts",
  javascript: "js",
  shell: "sh",
  golang: "go",
  ruby: "rb",
  csharp: "cs",
  kotlin: "kt",
  haskell: "hs",
  perl: "pl",
  powershell: "ps1",
  elixir: "ex",
  erlang: "erl",
  clojure: "clj",
  ocaml: "ml",
  plaintext: "txt",
  text: "txt",
};

/**
 * A synthetic filename whose extension carries the fence's language.
 * Passing the tag as `lang` instead would reject on unknown languages;
 * filename inference degrades to plain text.
 */
export function fenceFilename(tag: string | undefined): string {
  if (!tag) return "snippet.txt";
  return `snippet.${FENCE_TAG_EXTENSION[tag.toLowerCase()] ?? tag}`;
}

/**
 * Read-only code rendering through pierre CodeView: syntax highlighting
 * from the filename, dark/light theme in step with the revision diffs.
 * Until pierre renders its first line a plain <pre> shows the same text, so
 * content stays readable through both chunk loading and highlighter startup.
 *
 * pierre's virtualization scaffold declares `contain: inline-size`, so this
 * block contributes 0px to an ancestor's intrinsic width: in a content-sized
 * column (horizontal flex item, table cell, `max-content`) the code wraps at
 * the width of the prose beside it — 30 lines came out 5416px tall in a 109px
 * column, and a fence with no prose left the column 0px wide (T-287). Any such
 * column has to be made to fill its row.
 */
export function CodeBlock({
  filename,
  contents,
  lineNumbers = false,
  plain = false,
  offThread = false,
  className,
}: {
  filename: string;
  contents: string;
  /** Line numbers suit whole files; snippets read better without. */
  lineNumbers?: boolean;
  /**
   * No highlighting. Tokenizing is what costs: virtualized lines spare the
   * DOM, but pierre tokenizes the whole file regardless, 11 s for 1 MiB of
   * log where plain text took 0.16 s (T-582).
   */
  plain?: boolean;
  /**
   * Tokenize in pierre's worker pool. Only pays off with `className` capping
   * the height: uncapped, laying out every line of 1 MiB still held the main
   * thread for 2.2 s (T-584).
   */
  offThread?: boolean;
  /** Caps the height for a long file: CodeView virtualizes against its box. */
  className?: string;
}) {
  const items = useMemo(
    () => [
      {
        id: filename,
        type: "file" as const,
        file: plain
          ? { name: filename, contents, lang: "text" as const }
          : { name: filename, contents },
      },
    ],
    [filename, contents, plain],
  );
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(
    () =>
      lineNumbers ? fileOptions(syntaxTheme) : snippetOptions(syntaxTheme),
    [lineNumbers, syntaxTheme],
  );
  const [degraded, setDegraded] = useState(false);
  const [ready, setReady] = useState(contents === "");
  const filenameRef = useRef(filename);
  filenameRef.current = filename;
  const warned = useRef(false);
  // CodeView keeps the containerRef it was handed at mount, so the registered
  // handler reads the filename off a ref rather than closing over the prop.
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    // Unmount hands us null; the WeakMap entry dies with the node anyway.
    if (node === null) return;
    DEGRADE_HANDLERS.set(node, () => {
      if (!warned.current) {
        warned.current = true;
        console.warn(
          `syntax highlighting failed for ${filenameRef.current}; showing plain text`,
        );
      }
      setDegraded(true);
    });
    READY_HANDLERS.set(node, () => setReady(true));
  }, []);
  // Highlighting fails per grammar rather than per input, so a block that has
  // gone plain stays plain: re-arming it would only repeat the same failure.
  if (degraded) return <PlainCodeFallback contents={contents} />;
  // Plain text has nothing to tokenize, so no worker to start for it.
  const View = offThread && !plain ? ChunkWorkerCodeView : ChunkCodeView;
  return (
    <CodeViewBoundary contents={contents}>
      {!ready && <PlainCodeFallback contents={contents} />}
      <div style={ready ? undefined : { visibility: "hidden" }}>
        <View
          items={items}
          options={options}
          className={className}
          containerRef={containerRef}
        />
      </div>
    </CodeViewBoundary>
  );
}

function FenceDiff({
  filename,
  before,
  after,
}: {
  filename: string;
  before: string;
  after: string;
}) {
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(() => fenceDiffOptions(syntaxTheme), [syntaxTheme]);
  // A fence body carries no trailing newline, and pierre answers a last line
  // that takes part in a change by drawing "No newline at end of file" —
  // true of the string it was handed, meaningless to a reader of the document.
  const oldFile = useMemo(
    () => ({ name: filename, contents: `${before}\n` }),
    [filename, before],
  );
  const newFile = useMemo(
    () => ({ name: filename, contents: `${after}\n` }),
    [filename, after],
  );
  const [degraded, setDegraded] = useState(false);
  const [ready, setReady] = useState(after === "");
  const filenameRef = useRef(filename);
  filenameRef.current = filename;
  const warned = useRef(false);
  // MultiFileDiff takes no containerRef, so the handler goes on a wrapper of
  // our own; `handlePostRender` walks up from the failing container to find it.
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    DEGRADE_HANDLERS.set(node, () => {
      if (!warned.current) {
        warned.current = true;
        console.warn(
          `syntax highlighting failed for ${filenameRef.current}; showing plain text`,
        );
      }
      setDegraded(true);
    });
    READY_HANDLERS.set(node, () => setReady(true));
    // A warm pierre cache can synchronously render and emitPostRender from
    // the child's ref before this parent ref registers its handlers. Replay
    // any state already present in the shadow root so that signal is not lost.
    for (const container of node.querySelectorAll<HTMLElement>(
      "diffs-container",
    )) {
      handlePostRender(container);
    }
  }, []);
  if (degraded) return <PlainCodeFallback contents={after} />;
  return (
    <div ref={containerRef}>
      <CodeViewBoundary contents={after}>
        {!ready && <PlainCodeFallback contents={after} />}
        <div style={ready ? undefined : { visibility: "hidden" }}>
          <ChunkMultiFileDiff
            oldFile={oldFile}
            newFile={newFile}
            options={options}
          />
        </div>
      </CodeViewBoundary>
    </div>
  );
}

/**
 * One code block shown as the line-level diff between two versions of it:
 * red for the lines the baseline had, green for the ones that replaced them
 * (T-343).
 *
 * Nothing is injected into the code. pierre is handed both bodies as plain
 * strings and does its own diffing, highlighting and theming, so T-31's
 * constraint — a mark reaching inside a fence deletes the code it wraps — is
 * never engaged.
 */
export function CodeDiffBlock({
  filename,
  before,
  after,
}: {
  filename: string;
  before: string;
  after: string;
}) {
  // Identical sides produce zero hunks, and a hunkless diff with no file
  // header renders nothing at all — the block would vanish from the page.
  // Branching here rather than inside `FenceDiff` also keeps every hook in
  // both shapes unconditional.
  if (before === after) {
    return <CodeBlock filename={filename} contents={after} />;
  }
  return <FenceDiff filename={filename} before={before} after={after} />;
}

/** The CodeView item id of a patch's `index`-th file, counted across commits. */
export function patchFileId(index: number): string {
  return `file-${index}`;
}

/** The CodeView item id of a commit's message, counted across the patch. */
export function patchCommitId(index: number): string {
  return `commit-${index}`;
}

/**
 * A parsed patch in one virtualized CodeView: per commit, its message, then
 * one diff per file.
 *
 * `className` must cap the height. CodeView virtualizes against its own box,
 * so an uncapped one grows to the whole patch and lays every line out: a
 * 1 MB, 116-file patch froze the tab for 15 s in one task that way, against
 * under 0.3 s capped (T-528).
 *
 * A highlighter failure takes the whole patch back to its plain text rather
 * than one file: the grammar that failed is likely shared by its neighbours.
 */
export function PatchFiles({
  patches,
  text,
  className,
  viewRef,
  commits,
  collapsedFiles,
  renderHeader,
}: {
  patches: ParsedPatch[];
  /** The patch as written, for the plain-text fallback. */
  text: string;
  className: string;
  /** For scrolling to a file by `patchFileId`. */
  viewRef?: Ref<CodeViewHandle<undefined>>;
  /**
   * What each patch's preamble says, index for index with `patches`. A
   * commit gets an item of its own, carrying its message; null gets none.
   */
  commits: (PatchCommit | null)[];
  /** Files, by position across the patch, drawn as their header row only. */
  collapsedFiles?: ReadonlySet<number>;
  /**
   * Every item's header row, `PATCH_HEADER_HEIGHT` tall: pierre reserves that
   * height for it without measuring.
   */
  renderHeader: (item: CodeViewItem) => ReactNode;
}) {
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(() => patchOptions(syntaxTheme), [syntaxTheme]);
  const items = useMemo(() => {
    let position = 0;
    return patches.flatMap((patch, commit): CodeViewItem[] => {
      const files = patch.files.map((fileDiff): CodeViewItem => {
        const collapsed = collapsedFiles?.has(position) ?? false;
        return {
          id: patchFileId(position++),
          type: "diff",
          fileDiff,
          collapsed,
          // CodeView only takes a changed item from a changed version.
          version: collapsed ? 0 : 1,
        };
      });
      const parsed = commits[commit];
      if (parsed == null) return files;
      return [
        {
          id: patchCommitId(commit),
          type: "file",
          // Only the header row when there is no message under the subject.
          collapsed: parsed.body === "",
          file: {
            name: patchCommitId(commit),
            contents: parsed.body,
            lang: "text",
          },
        },
        ...files,
      ];
    });
  }, [patches, commits, collapsedFiles]);
  const [degraded, setDegraded] = useState(false);
  const warned = useRef(false);
  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    DEGRADE_HANDLERS.set(node, () => {
      if (!warned.current) {
        warned.current = true;
        console.warn(
          "syntax highlighting failed for a patch; showing plain text",
        );
      }
      setDegraded(true);
    });
  }, []);
  if (degraded) return <PlainCodeFallback contents={text} />;
  return (
    <CodeViewBoundary contents={text}>
      <ChunkCodeView
        fallback={<PlainCodeFallback contents={text} />}
        ref={viewRef}
        items={items}
        options={options}
        className={className}
        containerRef={containerRef}
        renderCustomHeader={renderHeader}
      />
    </CodeViewBoundary>
  );
}
