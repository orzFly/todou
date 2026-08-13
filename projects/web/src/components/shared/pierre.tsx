import type { CodeViewProps, MultiFileDiffProps } from "@pierre/diffs/react";
import { type ComponentType, lazy, Suspense, useMemo } from "react";

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

// Module-scope per the library's props-stability guidance.
const SNIPPET_OPTIONS = {
  theme: PIERRE_THEME,
  themeType: PIERRE_THEME_TYPE,
  disableFileHeader: true,
  disableLineNumbers: true,
  overflow: "wrap",
} as const;

const FILE_OPTIONS = {
  theme: PIERRE_THEME,
  themeType: PIERRE_THEME_TYPE,
  disableFileHeader: true,
} as const;

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
  return (
    <Suspense
      fallback={
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.85em] leading-[1.45]">
          <code>{contents}</code>
        </pre>
      }
    >
      <LazyCodeView
        items={items}
        options={lineNumbers ? FILE_OPTIONS : SNIPPET_OPTIONS}
        className={className}
      />
    </Suspense>
  );
}
