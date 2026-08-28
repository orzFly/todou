import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type {
  AutolinkRule,
  IssueListItem,
  PrefixDirectory,
} from "@todou/shared";
import { resolveClaim } from "@todou/shared";
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
const QUALIFIED = new RegExp(
  `(?:^|[^\\w-])([a-z0-9][a-z0-9-]*)(#|/#?)${QUERY}`,
);
const BARE_PREFIX = new RegExp(`(?:^|[^\\w-])([A-Z][A-Z0-9_]*-)${QUERY}`);

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
 */
export function refTriggerAt(
  text: string,
  ctx: RefTriggerContext,
): RefTrigger | null {
  if (ctx.directory !== null) {
    const qualified = QUALIFIED.exec(text);
    if (qualified !== null) {
      const slug = qualified[1] as string;
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
      const anchor = bare[1] as string;
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
    // Cheap reject before touching the cache or the syntax tree: every
    // spelling in the grammar contains one of these.
    if (!/[#/-]/.test(before)) return null;
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
      // No cutoff (or a server predating T-150) means bare and qualified
      // foreign forms never resolve — the renderer's rule exactly.
      directory: directory?.since === null ? null : (directory ?? null),
    });
    if (found === null) return null;

    const page = await queryClient
      .fetchQuery(issueCompletionQuery(found.slug))
      .catch(() => null);
    if (page === null || context.aborted) return null;
    const items = rankCandidates(page.items, found.query);
    const seen = new Set(items.map((item) => item.number));

    // A number past the recent window still has to be completable, and a
    // word deserves a real search: neither is in the cached page.
    if (/^[0-9]+$/.test(found.query)) {
      const exact = await queryClient
        .fetchQuery(issueRefQuery(found.slug, Number(found.query)))
        .catch(() => null);
      if (context.aborted) return null;
      if (exact !== null && !seen.has(exact.number)) items.unshift(exact);
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
 */
export function completionWith(sources: CompletionSource[]): Extension {
  return [autocompletion({ override: sources }), completionTheme];
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
});
