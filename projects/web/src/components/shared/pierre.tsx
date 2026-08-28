import type { CodeViewProps, MultiFileDiffProps } from "@pierre/diffs/react";
import { type ComponentType, lazy, Suspense, useMemo } from "react";
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
  } as const;
  FILE_OPTIONS.set(theme, options);
  return options;
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
  return (
    <Suspense
      fallback={
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[0.85em] leading-[1.45]">
          <code>{contents}</code>
        </pre>
      }
    >
      <LazyCodeView items={items} options={options} className={className} />
    </Suspense>
  );
}
