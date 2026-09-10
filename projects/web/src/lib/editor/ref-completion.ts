import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  startCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type {
  AutolinkRule,
  IssueListItem,
  PrefixDirectory,
} from "@todou/shared";
import { PREFIX_PATTERN, resolveClaim, SLUG_PATTERN } from "@todou/shared";
import { useMemo } from "react";
import { issueRefQuery } from "@/api/issue-refs.ts";
import {
  issueCompletionQuery,
  issueCompletionSearchQuery,
} from "@/api/issues.ts";
import { projectsQuery } from "@/api/queries.ts";
import {
  referenceConfigQuery,
  referenceDirectoryQuery,
} from "@/api/references.ts";
import {
  type ProjectRefOption,
  projectSpellings,
} from "@/lib/project-spellings.ts";

/**
 * Issue-reference completion (T-161) for every markdown surface. Input
 * assistance only: it inserts nothing the T-150 grammar would not have
 * understood typed by hand, so what the panel produces is exactly what the
 * renderer links and the server records a `referenced` event for.
 */

export type RefTriggerContext = {
  /** The project the surface belongs to. */
  slug: string;
  /** This project's internal format: null = `#N`, "T" = `T-N`. */
  prefix: string | null;
  /** Slugs the viewer may name; anything else stays literal text. */
  readableSlugs: readonly string[];
  /** Null = the cross-project grammar is shut, so no foreign spellings. */
  directory: PrefixDirectory | null;
  autolinks: readonly AutolinkRule[];
};

export type RefTrigger = {
  /** The project to search. */
  slug: string;
  /** Spelling already typed, kept verbatim on insert: "#", "T-", "mirror#". */
  anchor: string;
  /** Offset of the anchor's first character within the text examined. */
  at: number;
  /** What was typed after the anchor. */
  query: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// No whitespace in the run, and no second `#` or `/`, so one token never
// swallows the start of the next.
const QUERY = "([^\\s#/]*)$";
// `i` so that reaching for the shift key is never what stands between the
// typist and a candidate; the anchor is folded back before anything resolves.
const QUALIFIED = new RegExp(
  `(?:^|[^\\w-])(${SLUG_PATTERN})(#|/#?)${QUERY}`,
  "i",
);
const BARE_PREFIX = new RegExp(
  `(?:^|[^\\w-])(${PREFIX_PATTERN}-)${QUERY}`,
  "i",
);

const trigger = (
  text: string,
  slug: string,
  anchor: string,
  query: string,
): RefTrigger => ({
  slug,
  anchor,
  at: text.length - query.length - anchor.length,
  query,
});

/**
 * The reference the cursor is in the middle of typing, if any. Priority
 * mirrors `scanReferenceTokens`: qualified forms, then this project's own
 * format, then autolinks — which suppress completion, being external URLs
 * rather than issues — then a bare foreign prefix.
 *
 * Three places now walk that order: `claimAt` anchored left-to-right in
 * prose, this one matching backwards from the cursor, and the CLI's
 * `resolvePrefixedRef` matching one whole argument (T-214). The shapes are
 * shared (`ref-shapes.ts`) and so is the order; the matching itself is not,
 * because those are three different operations and one function with three
 * mode switches reads worse at all three call sites.
 *
 * Matching ignores case and the anchor comes back folded to the canonical
 * spelling — lower in the slug position, upper in the prefix position. Those
 * two character sets do not overlap, so the canonical spelling is unique and
 * folding needs no disambiguation, the same reasoning `foldRefSpelling`
 * rests on. Everything downstream — `readableSlugs`, `resolveClaim`, the
 * renderer, the server's extraction — keeps comparing exactly, and the
 * spelling handed to them is one they recognise.
 */
export function refTriggerAt(
  text: string,
  ctx: RefTriggerContext,
): RefTrigger | null {
  if (ctx.directory !== null) {
    const qualified = QUALIFIED.exec(text);
    if (qualified !== null) {
      const slug = (qualified[1] as string).toLowerCase();
      const anchor = `${slug}${qualified[2]}`;
      // A shape naming a project the viewer cannot read is literal text to
      // the grammar, so it must not fall through to this project's format.
      if (!ctx.readableSlugs.includes(slug)) return null;
      return trigger(text, slug, anchor, qualified[3] as string);
    }
  }

  const internal = ctx.prefix === null ? "#" : `${ctx.prefix}-`;
  // A hyphen before a word-led token is what keeps SOME-T-76 plain text.
  const boundary = ctx.prefix === null ? "[^\\w]" : "[^\\w-]";
  const local = new RegExp(
    `(?:^|${boundary})(${escapeRegExp(internal)})${QUERY}`,
    "i",
  ).exec(text);
  if (local !== null) {
    return trigger(text, ctx.slug, internal, local[2] as string);
  }

  for (const rule of ctx.autolinks) {
    if (new RegExp(`${escapeRegExp(rule.prefix)}[0-9]*$`).test(text)) {
      return null;
    }
  }

  if (ctx.directory !== null) {
    const bare = BARE_PREFIX.exec(text);
    if (bare !== null) {
      const anchor = (bare[1] as string).toUpperCase();
      const slug = resolveClaim(
        ctx.directory.entries,
        ctx.directory.contested,
        anchor.slice(0, -1),
        new Date().toISOString(),
      );
      if (slug !== null) {
        return trigger(text, slug, anchor, bare[2] as string);
      }
    }
  }
  return null;
}

/**
 * A hyphenated run is one word, which is what lets `my-pro` reach
 * `my-project/`. It also means the part after a hyphen is never a word of
 * its own, so `x-mir` offers nothing — the outcome the grammar's boundary
 * rule already gives `SOME-T-76`.
 */
const PROJECT_WORD = /(?:^|[^\w-])([A-Za-z0-9][A-Za-z0-9-]*)$/;

/**
 * The bare word the cursor is at the end of — a project name still being
 * typed, before any `#`, `/` or `-` has said which project it is.
 */
export function projectTriggerAt(
  text: string,
): { at: number; typed: string } | null {
  const found = PROJECT_WORD.exec(text);
  if (found === null) return null;
  const typed = found[1] as string;
  return { at: text.length - typed.length, typed };
}

/**
 * Shortest word that may open the project panel. Measured over this
 * repository's English documentation (2786 words) against a pool of `T-`
 * and `todou/` plus a second project's prefix and slug: one character opens
 * on 18.5% of words,
 * two on 5.6%, three on 2.5% — and of those 69 hits, 60 are the word "todou"
 * itself, where opening is the right answer. Four characters selects exactly
 * the same words as three, so three is the shortest threshold whose hits
 * have stopped being ordinary prose.
 */
const MIN_PROJECT_QUERY = 3;

/**
 * One row per project, offered against the bare word, the way
 * `projectRefSource` offers them in the search box: the best spelling the
 * typed text is a prefix of, matched without regard to case, and nothing
 * completed to itself.
 */
function projectOptions(pool: ProjectRefOption[], typed: string): Completion[] {
  const lower = typed.toLowerCase();
  const options: Completion[] = [];
  for (const project of pool) {
    const spelling = project.spellings.find(
      (candidate) =>
        candidate.toLowerCase().startsWith(lower) &&
        candidate.toLowerCase() !== lower,
    );
    if (spelling === undefined) continue;
    options.push({
      label: spelling,
      detail: project.name,
      type: "project-ref",
      apply: (view, _completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: spelling },
          selection: { anchor: from + spelling.length },
        });
        // A project is half a reference. Reopening the panel on the spot is
        // what carries `mir` Tab `1` through to mirror#1 in one run.
        startCompletion(view);
      },
    });
  }
  return options;
}

/** Node names @lezer/markdown gives code, where the grammar reads no refs. */
const CODE_NODES = new Set([
  "CodeText",
  "CodeBlock",
  "FencedCode",
  "InlineCode",
  "CodeMark",
  "CommentBlock",
  "Comment",
  "HTMLBlock",
  "HTMLTag",
]);

type SyntaxNode = { name: string; parent: SyntaxNode | null };

export function inCodeContext(
  tree: { resolveInner: (pos: number, side: -1) => SyntaxNode },
  pos: number,
): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node !== null) {
    if (CODE_NODES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

/** How the candidate list orders itself against what was typed. */
export function rankCandidates(
  items: IssueListItem[],
  query: string,
): IssueListItem[] {
  if (query === "") return [...items];
  const numeric = /^[0-9]+$/.test(query);
  if (!numeric) {
    const lower = query.toLowerCase();
    return items.filter((item) => item.title.toLowerCase().includes(lower));
  }
  const exact = Number(query);
  // The exact number is what the typist meant; prefix matches follow,
  // smallest first, so #1 does not hide behind #1000.
  return items
    .filter((item) => String(item.number).startsWith(query))
    .sort((a, b) => {
      if (a.number === exact) return -1;
      if (b.number === exact) return 1;
      return a.number - b.number;
    });
}

const MAX_OPTIONS = 20;

function toOption(anchor: string, item: IssueListItem): Completion {
  const spelling = `${anchor}${item.number}`;
  return {
    label: spelling,
    detail: item.title,
    type: item.status.category === "closed" ? "issue-closed" : "issue-open",
    // Only the number is added; the spelling the typist chose survives.
    apply: spelling,
  };
}

/**
 * A CompletionSource for issue references, reading its inputs through the
 * query cache so it can live in a plain extension rather than a component.
 * All three lookups carry a 60s staleTime, so after the first keystroke this
 * is a cache read.
 */
export function refCompletionSource(
  slug: string,
  queryClient: QueryClient,
): CompletionSource {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const word = projectTriggerAt(before);
    // PERF: this reject has to stay ahead of every await. A bare word can
    // open the panel now, so English prose reaches the cache reads on every
    // keystroke; Chinese prose yields no word and stops on this line.
    if (word === null && !/[#/-]/.test(before)) return null;
    if (inCodeContext(syntaxTree(context.state), context.pos)) return null;

    const inputs = await Promise.all([
      queryClient.fetchQuery(referenceConfigQuery(slug)).catch(() => null),
      queryClient.fetchQuery(referenceDirectoryQuery).catch(() => null),
      queryClient.fetchQuery(projectsQuery).catch(() => null),
    ]);
    const [config, directory, projects] = inputs;
    if (config === null || context.aborted) return null;

    const found = refTriggerAt(before, {
      slug,
      prefix: config.format.prefix,
      autolinks: config.autolinks,
      readableSlugs: projects?.map((p) => p.slug) ?? [],
      // No directory (a server predating T-150, or one that could not be
      // read) means bare and qualified foreign forms never resolve — the
      // renderer's rule exactly.
      directory: directory ?? null,
    });
    // The project level runs only where no shape matched: once one has, the
    // reader has already said which project they mean.
    if (found === null) {
      if (word === null || word.typed.length < MIN_PROJECT_QUERY) return null;
      const options = projectOptions(
        projectSpellings(projects ?? undefined, directory),
        word.typed,
      );
      if (options.length === 0) return null;
      return { from: line.from + word.at, filter: false, options };
    }

    const page = await queryClient
      .fetchQuery(issueCompletionQuery(found.slug))
      .catch(() => null);
    if (page === null || context.aborted) return null;
    const items = rankCandidates(page.items, found.query);
    const seen = new Set(items.map((item) => item.number));

    // A number past the recent window still has to be completable, and a
    // word deserves a real search: neither is in the cached page.
    if (/^[0-9]+$/.test(found.query)) {
      const asked = Number(found.query);
      const exact = await queryClient
        .fetchQuery(issueRefQuery(found.slug, asked))
        .catch(() => null);
      if (context.aborted) return null;
      // The number asked for, not the one the lookup came back with: a moved
      // card answers from its new home, and the option is spelled against the
      // project asked, where that number names a different card or none. The
      // written form stays resolvable because the resolve pass follows the
      // move when it stores the link.
      if (exact !== null && !seen.has(asked)) {
        items.unshift({ ...exact, number: asked });
      }
    } else if (found.query.length >= 2) {
      const hits = await queryClient
        .fetchQuery(issueCompletionSearchQuery(found.slug, found.query))
        .catch(() => null);
      if (context.aborted) return null;
      for (const item of hits?.items ?? []) {
        if (!seen.has(item.number)) {
          seen.add(item.number);
          items.push(item);
        }
      }
    }
    if (items.length === 0) return null;

    return {
      from: line.from + found.at,
      // Ranking and filtering already happened, against the grammar and a
      // server search; CodeMirror's fuzzy filter would drop the search hits,
      // whose numbers look nothing like the words that found them.
      filter: false,
      options: items
        .slice(0, MAX_OPTIONS)
        .map((item) => toOption(found.anchor, item)),
    };
  };
}

/**
 * One `autocompletion()` for a surface. Several sources have to share one
 * instance: a second call would install a second panel that competes with
 * the first for the same keys.
 *
 * Tab lives here rather than in the editor's own keymap so that only a
 * surface with a panel claims the key. `acceptCompletion` returns false with
 * no panel open and no row selected, which leaves the event unhandled and
 * the browser free to move focus as it always has. Shift-Tab is left
 * unbound for the same reason, and Enter is left to `completionKeymap`,
 * where a project row and a card row are accepted by the same rule.
 */
export function completionWith(sources: CompletionSource[]): Extension {
  return [
    Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
    autocompletion({ override: sources }),
    completionTheme,
  ];
}

/**
 * Reference completion for a markdown surface, memoized — the editor
 * reconfigures its extension compartment whenever this identity changes, and
 * a reconfigure mid-typing would close the open panel.
 */
export function useRefCompletion(slug: string): Extension {
  const queryClient = useQueryClient();
  return useMemo(
    () => completionWith([refCompletionSource(slug, queryClient)]),
    [slug, queryClient],
  );
}

/**
 * Panel styling. CodeMirror draws its icons through CSS `content`, and every
 * colour has to come from a theme variable so both palettes — and `.dark` —
 * follow without a rebuild.
 */
export const completionTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--border)",
    borderRadius: "0.5rem",
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow:
      "0 4px 6px -1px color-mix(in oklab, var(--foreground) 12%, transparent)",
    overflow: "hidden",
    fontFamily: "var(--font-sans)",
  },
  ".cm-tooltip-autocomplete > ul": {
    maxHeight: "16rem",
    fontFamily: "inherit",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "baseline",
    gap: "0.375rem",
    padding: "0.25rem 0.5rem",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-completionLabel": { flex: "0 0 auto", fontFamily: "var(--font-mono)" },
  ".cm-completionDetail": {
    flex: "1 1 auto",
    fontStyle: "normal",
    color: "var(--muted-foreground)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-completionIcon": { width: "1em", paddingRight: "0", opacity: "1" },
  ".cm-completionIcon-issue-open::after": {
    content: "'○'",
    color: "var(--primary)",
  },
  ".cm-completionIcon-issue-closed::after": {
    content: "'●'",
    color: "var(--muted-foreground)",
  },
  ".cm-completionIcon-command::after": {
    content: "'/'",
    color: "var(--primary)",
  },
  ".cm-completionIcon-project-ref::after": {
    content: "'◇'",
    color: "var(--muted-foreground)",
  },
});
