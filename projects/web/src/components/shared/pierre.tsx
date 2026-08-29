import type { CodeViewProps, MultiFileDiffProps } from "@pierre/diffs/react";
import {
  Component,
  type ComponentType,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { syntaxThemeOf, type ThemePref, useThemePref } from "@/lib/theme.ts";

// @pierre/diffs is the heaviest dependency in the web bundle (T-24). Every
// value import goes through lazy() here so the library lands in its own
// chunk, fetched the first time a code surface actually renders; the rest
// of the app must only use type imports.
const LazyCodeView = lazy(() =>
  import("@pierre/diffs/react").then((m) => ({
    default: m.CodeView as ComponentType<CodeViewProps>,
  })),
);

export const LazyMultiFileDiff = lazy(() =>
  import("@pierre/diffs/react").then((m) => ({
    default: m.MultiFileDiff as ComponentType<MultiFileDiffProps<undefined>>,
  })),
);

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
function PlainCodeFallback({ contents }: { contents: string }) {
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
  if (container.shadowRoot?.querySelector("[data-error-wrapper]") == null) {
    return;
  }
  for (let node: Element | null = container; node; node = node.parentElement) {
    const degrade = DEGRADE_HANDLERS.get(node);
    if (degrade !== undefined) {
      degrade();
      return;
    }
  }
}

// Module-scope per the library's props-stability guidance — now one object
// per theme rather than one overall, so a surface only re-renders when the
// theme it is rendered under actually changes.
const SNIPPET_OPTIONS = new Map<SyntaxTheme, CodeViewProps["options"]>();
const FILE_OPTIONS = new Map<SyntaxTheme, CodeViewProps["options"]>();

function snippetOptions(theme: SyntaxTheme): CodeViewProps["options"] {
  const cached = SNIPPET_OPTIONS.get(theme);
  if (cached) return cached;
  const options = {
    theme,
    themeType: PIERRE_THEME_TYPE,
    disableFileHeader: true,
    disableLineNumbers: true,
    overflow: "wrap",
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
    onPostRender: handlePostRender,
  } as const;
  FILE_OPTIONS.set(theme, options);
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
 * Until the pierre chunk arrives a plain <pre> shows the same text, so
 * content is readable immediately.
 */
export function CodeBlock({
  filename,
  contents,
  lineNumbers = false,
  className,
}: {
  filename: string;
  contents: string;
  /** Line numbers suit whole files; snippets read better without. */
  lineNumbers?: boolean;
  className?: string;
}) {
  const items = useMemo(
    () => [
      {
        id: filename,
        type: "file" as const,
        file: { name: filename, contents },
      },
    ],
    [filename, contents],
  );
  const syntaxTheme = useSyntaxTheme();
  const options = useMemo(
    () =>
      lineNumbers ? fileOptions(syntaxTheme) : snippetOptions(syntaxTheme),
    [lineNumbers, syntaxTheme],
  );
  const [degraded, setDegraded] = useState(false);
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
  }, []);
  // Highlighting fails per grammar rather than per input, so a block that has
  // gone plain stays plain: re-arming it would only repeat the same failure.
  if (degraded) return <PlainCodeFallback contents={contents} />;
  return (
    <CodeViewBoundary contents={contents}>
      <Suspense fallback={<PlainCodeFallback contents={contents} />}>
        <LazyCodeView
          items={items}
          options={options}
          className={className}
          containerRef={containerRef}
        />
      </Suspense>
    </CodeViewBoundary>
  );
}
