import {
  type AutolinkRule,
  type IssueListItem,
  PREFIX_PATTERN,
  type PrefixDirectory,
  parseInternalHref,
  parseRefLocator,
  resolveClaim,
  SLUG_PATTERN,
} from "@todou/shared";

/**
 * Issue-reference syntax shared by the markdown editor completion panel and
 * the single-line reference picker. UI concerns stay in their own modules.
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
export const MIN_PROJECT_QUERY = 3;

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

export type PickerTrigger =
  /** `fromShape` = the input already has a ref marker naming a project. */
  | {
      kind: "cards";
      slug: string;
      query: string;
      anchor: string;
      fromShape: boolean;
    }
  | { kind: "raw" };

export function parsesAsRef(value: string, origin: string): boolean {
  const trimmed = value.trim();
  if (/^#?\d{1,15}$/.test(trimmed)) return true;
  if (parseRefLocator(trimmed) !== null) return true;
  return parseInternalHref(trimmed, origin)?.kind === "issue";
}

export function pickerTriggerAt(
  value: string,
  ctx: RefTriggerContext,
  origin: string,
): PickerTrigger {
  const trimmed = value.trim();
  const internal = ctx.prefix === null ? "#" : `${ctx.prefix}-`;
  if (trimmed === "") {
    return {
      kind: "cards",
      slug: ctx.slug,
      query: "",
      anchor: internal,
      fromShape: false,
    };
  }
  const number = /^#?(\d{1,15})$/.exec(trimmed);
  if (number !== null) {
    return {
      kind: "cards",
      slug: ctx.slug,
      query: number[1] as string,
      anchor: internal,
      fromShape: true,
    };
  }
  const ref = refTriggerAt(trimmed, ctx);
  if (ref !== null) {
    return {
      kind: "cards",
      slug: ref.slug,
      query: ref.query,
      anchor: ref.anchor,
      fromShape: true,
    };
  }
  if (parsesAsRef(trimmed, origin)) return { kind: "raw" };
  return {
    kind: "cards",
    slug: ctx.slug,
    query: trimmed,
    anchor: internal,
    fromShape: false,
  };
}
