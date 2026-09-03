/**
 * The reference grammar both ends share. The server extractor
 * (projects/server/src/services/references.ts) records events from
 * exactly the tokens the web tokenizer (projects/web/src/lib/issue-refs.ts)
 * renders as links; two hand-mirrored copies of the patterns drifted
 * apart as soon as the grammar grew past `#N`, so both now consume this.
 *
 * Existence is never decided here: the scanner emits candidates and the
 * caller injects what it knows (slug set, prefix directory), which keeps
 * this module a pure function on either side of the wire.
 */

import {
  MAX_PREFIX_LENGTH,
  PREFIX_BODY_CLASS,
  PREFIX_HEAD_CLASS,
  SLUG_BODY_CLASS,
  SLUG_HEAD_CLASS,
} from "./ref-shapes.ts";

export type AutolinkRule = { prefix: string; url_template: string };

/** One project's hold on a bare prefix over `[from, to)`; `to: null` = still held. */
export type PrefixClaim = {
  prefix: string;
  slug: string;
  from: string;
  to: string | null;
};

/** A window where several projects held `prefix`, so it resolves to nobody. */
export type ContestedPrefix = {
  prefix: string;
  from: string;
  to: string | null;
};

export type PrefixDirectory = {
  entries: readonly PrefixClaim[];
  contested: readonly ContestedPrefix[];
};

/**
 * One project's hold on a slug over `[from, to)`; `to: null` = still its
 * current slug, in which case `canonical` equals `slug` (T-156).
 */
export type SlugClaim = {
  slug: string;
  canonical: string;
  from: string;
  to: string | null;
};

/**
 * Cross-project inputs (T-150). Supplying this turns the extended grammar
 * on; leaving it out yields the pre-T-150 token stream exactly.
 */
export type CrossRefInput = {
  /** Slugs the caller can vouch for; a qualified form naming anything else stays literal. */
  slugs: readonly string[];
  /** Absent = bare `PREFIX-N` never resolves; qualified forms still do. */
  directory?: PrefixDirectory;
  /** Absent = `slugs` alone decides a qualified form, as before T-156. */
  slugEntries?: readonly SlugClaim[];
  /** `cross_refs_since`. Null/absent means "unknown", which turns the grammar off. */
  since?: string | null;
  /** When the content was written; omitted reads as now. */
  at?: string;
};

export type ScanConfig = {
  /** null = `#N`, 'T' = `T-N`. The format in force when the content was written. */
  internalPrefix: string | null;
  autolinks?: readonly AutolinkRule[];
  cross?: CrossRefInput;
};

type Span = { start: number; end: number; text: string };

export type ReferenceToken =
  | (Span & { type: "text" })
  | (Span & {
      type: "issue";
      /** null = this project. */
      slug: string | null;
      number: number;
      commentId?: number;
    })
  | (Span & { type: "comment"; commentId: number })
  | (Span & { type: "autolink"; href: string });

const WORD = /\w/;
const DIGIT = /[0-9]/;
const SLUG_HEAD = new RegExp(SLUG_HEAD_CLASS);
const SLUG_BODY = new RegExp(SLUG_BODY_CLASS);
const PREFIX_HEAD = new RegExp(PREFIX_HEAD_CLASS);
const PREFIX_BODY = new RegExp(PREFIX_BODY_CLASS);
const MAX_PREFIX = MAX_PREFIX_LENGTH;
const COMMENT_TOKEN = "#comment-";

/**
 * The `(?:^|\W)` / `(?:^|[^\w-])` left boundary. Word-led tokens also
 * reject a preceding hyphen, which is what keeps SOME-T-76 plain text.
 */
function boundaryOk(text: string, at: number, wordLed: boolean): boolean {
  if (at === 0) return true;
  const prev = text[at - 1] as string;
  if (WORD.test(prev)) return false;
  return wordLed ? prev !== "-" : true;
}

/**
 * `\d{1,9}\b`. A tenth digit or a trailing word character kills the match
 * outright rather than shortening it — the regex has no shorter
 * alternative that satisfies the word boundary either.
 */
function digitsAt(
  text: string,
  at: number,
): { value: number; end: number } | null {
  let end = at;
  while (end < text.length && DIGIT.test(text[end] as string)) end++;
  const length = end - at;
  if (length < 1 || length > 9) return null;
  if (end < text.length && WORD.test(text[end] as string)) return null;
  return { value: Number(text.slice(at, end)), end };
}

function runOf(text: string, at: number, pattern: RegExp): number {
  let end = at;
  while (end < text.length && pattern.test(text[end] as string)) end++;
  return end;
}

function literalRefAt(
  text: string,
  at: number,
  token: string,
): { value: number; end: number } | null {
  if (!text.startsWith(token, at)) return null;
  return digitsAt(text, at + token.length);
}

/** `#comment-M` riding behind an issue token, or standing on its own. */
function commentSuffixAt(
  text: string,
  at: number,
): { id: number; end: number } | null {
  if (!text.startsWith(COMMENT_TOKEN, at)) return null;
  const digits = digitsAt(text, at + COMMENT_TOKEN.length);
  return digits === null ? null : { id: digits.value, end: digits.end };
}

/** `P-N` where P only has to look like a prefix; the value is resolved elsewhere. */
function prefixedRefAt(
  text: string,
  at: number,
): { prefix: string; value: number; end: number } | null {
  if (!PREFIX_HEAD.test(text[at] ?? "")) return null;
  const stop = runOf(text, at + 1, PREFIX_BODY);
  const prefix = text.slice(at, stop);
  if (prefix.length > MAX_PREFIX || text[stop] !== "-") return null;
  const digits = digitsAt(text, stop + 1);
  return digits === null
    ? null
    : { prefix, value: digits.value, end: digits.end };
}

/**
 * `slug#N`, `slug/N`, `slug/#N`, `slug/P-N` — one meaning, four spellings.
 *
 * `prefix` is what the fourth spelling wrote and null for the other three.
 * The scanner ignores it (a slug names its project outright, so there is
 * nothing left to resolve); it rides along for `parseRefLocator`, whose
 * callers do validate it against the named project (T-214).
 */
function qualifiedRefAt(
  text: string,
  at: number,
): { slug: string; prefix: string | null; value: number; end: number } | null {
  if (!SLUG_HEAD.test(text[at] ?? "")) return null;
  const stop = runOf(text, at + 1, SLUG_BODY);
  const slug = text.slice(at, stop);
  const sep = text[stop];
  if (sep === "#") {
    const digits = digitsAt(text, stop + 1);
    return digits === null
      ? null
      : { slug, prefix: null, value: digits.value, end: digits.end };
  }
  if (sep !== "/") return null;
  const after = stop + 1;
  if (text[after] === "#") {
    const digits = digitsAt(text, after + 1);
    return digits === null
      ? null
      : { slug, prefix: null, value: digits.value, end: digits.end };
  }
  const digits = digitsAt(text, after);
  if (digits !== null) {
    return { slug, prefix: null, value: digits.value, end: digits.end };
  }
  const prefixed = prefixedRefAt(text, after);
  return prefixed === null
    ? null
    : {
        slug,
        prefix: prefixed.prefix,
        value: prefixed.value,
        end: prefixed.end,
      };
}

/**
 * One whole argument read as an issue locator, for a CLI positional rather
 * than for prose (T-214). Only the two shapes that name a project other
 * than "wherever this was typed" — a bare prefix, or a slug-qualified form.
 *
 * `16` and `#16` are deliberately not covered: they have no shape question
 * to answer, and the shared `digitsAt` caps a number at nine digits while
 * the CLI's own `parsePositiveInt` does not. Leaving them to the caller
 * keeps that cap from spreading into an unrelated tightening.
 */
export type RefLocator =
  | { kind: "prefixed"; prefix: string; number: number }
  | { kind: "qualified"; slug: string; number: number; prefix: string | null };

/** null = not one of those two shapes, malformed input included. */
export function parseRefLocator(value: string): RefLocator | null {
  const qualified = qualifiedRefAt(value, 0);
  if (qualified !== null && qualified.end === value.length) {
    return {
      kind: "qualified",
      slug: qualified.slug,
      number: qualified.value,
      prefix: qualified.prefix,
    };
  }
  const prefixed = prefixedRefAt(value, 0);
  if (prefixed !== null && prefixed.end === value.length) {
    return {
      kind: "prefixed",
      prefix: prefixed.prefix,
      number: prefixed.value,
    };
  }
  return null;
}

/**
 * The project holding `prefix` at `at`, or null when nobody or several do.
 * Ambiguity resolves to plain text on purpose: any tie-break would be a
 * guess, and the qualified form is always available to say it exactly.
 */
export function resolveClaim(
  entries: readonly PrefixClaim[],
  contested: readonly ContestedPrefix[],
  prefix: string,
  at: string,
): string | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  const covers = (from: string, to: string | null): boolean =>
    Date.parse(from) <= time && (to === null || time < Date.parse(to));
  if (contested.some((c) => c.prefix === prefix && covers(c.from, c.to))) {
    return null;
  }
  const holders = entries.filter(
    (e) => e.prefix === prefix && covers(e.from, e.to),
  );
  return holders.length === 1 ? (holders[0] as PrefixClaim).slug : null;
}

/**
 * The project a qualified `slug#N` names, given who held that slug when the
 * content was written (T-156). Three tiers, in order:
 *
 * 1. **The holder at `at`** — a renamed-away slug keeps pointing at what it
 *    meant when it was typed, which is the whole reason the history exists.
 * 2. **The current holder** — content dated before the project existed still
 *    resolves, the pre-T-156 behaviour this must not regress.
 * 3. **The last holder** — a slug nobody holds now still resolves to whoever
 *    had it last, because people keep typing the old name from memory after
 *    a rename.
 *
 * Returns the holder's *current* slug, so callers compare against live slugs
 * without knowing anything about the history.
 */
export function resolveSlugAt(
  entries: readonly SlugClaim[],
  slugs: readonly string[],
  slug: string,
  at: string,
): string | null {
  const time = Date.parse(at);
  const held = entries.filter((entry) => entry.slug === slug);
  if (!Number.isNaN(time)) {
    const covering = held.find(
      (entry) =>
        Date.parse(entry.from) <= time &&
        (entry.to === null || time < Date.parse(entry.to)),
    );
    if (covering !== undefined) return covering.canonical;
  }
  if (slugs.includes(slug)) return slug;
  let latest: SlugClaim | null = null;
  for (const entry of held) {
    if (latest === null || Date.parse(entry.from) > Date.parse(latest.from)) {
      latest = entry;
    }
  }
  return latest === null ? null : latest.canonical;
}

/**
 * The cross grammar only opens for content written at or after the
 * deployment's `cross_refs_since` (the T-80 discipline: existing text
 * never changes meaning under a new syntax). An unknown or unparseable
 * cutoff fails closed.
 */
function crossActiveAt(cross: CrossRefInput | undefined): CrossRefInput | null {
  if (cross === undefined) return null;
  if (cross.since === undefined || cross.since === null) return null;
  const since = Date.parse(cross.since);
  if (Number.isNaN(since)) return null;
  if (cross.at === undefined) return cross;
  const at = Date.parse(cross.at);
  if (Number.isNaN(at) || at < since) return null;
  return cross;
}

type Claim = { token: ReferenceToken | null; end: number };

const span = (text: string, start: number, end: number): Span => ({
  start,
  end,
  text: text.slice(start, end),
});

/**
 * Priority is fixed here rather than left to the caller: qualified forms
 * and comment anchors first (a longer, unambiguous token), then this
 * project's own format, then autolinks, then bare foreign prefixes. The
 * middle two are lexer convention; autolinks outranking bare prefixes is
 * the deliberate call that an admin's explicit local rule beats another
 * project's implicit global one (T-150).
 */
function claimAt(
  text: string,
  at: number,
  config: ScanConfig,
  cross: CrossRefInput | null,
): Claim | null {
  if (cross !== null) {
    const qualified = qualifiedRefAt(text, at);
    if (qualified !== null && boundaryOk(text, at, true)) {
      // A shape naming an unknown project is consumed as literal text
      // rather than re-scanned: `nowhere/T-12` must not fall through and
      // ping this project's own T-12.
      const canonical =
        cross.slugEntries === undefined
          ? cross.slugs.includes(qualified.slug)
            ? qualified.slug
            : null
          : resolveSlugAt(
              cross.slugEntries,
              cross.slugs,
              qualified.slug,
              cross.at ?? new Date().toISOString(),
            );
      if (canonical === null) {
        return { token: null, end: qualified.end };
      }
      const comment = commentSuffixAt(text, qualified.end);
      const end = comment?.end ?? qualified.end;
      return {
        token: {
          type: "issue",
          // Normalised, so a reference typed with a retired slug compares
          // equal to the project it actually names.
          slug: canonical,
          number: qualified.value,
          ...(comment === null ? {} : { commentId: comment.id }),
          ...span(text, at, end),
        },
        end,
      };
    }
    const comment = commentSuffixAt(text, at);
    if (comment !== null && boundaryOk(text, at, false)) {
      return {
        token: {
          type: "comment",
          commentId: comment.id,
          ...span(text, at, comment.end),
        },
        end: comment.end,
      };
    }
  }

  const internal =
    config.internalPrefix === null
      ? { token: "#", wordLed: false }
      : { token: `${config.internalPrefix}-`, wordLed: true };
  const local = literalRefAt(text, at, internal.token);
  if (local !== null && boundaryOk(text, at, internal.wordLed)) {
    const comment = cross === null ? null : commentSuffixAt(text, local.end);
    const end = comment?.end ?? local.end;
    return {
      token: {
        type: "issue",
        slug: null,
        number: local.value,
        ...(comment === null ? {} : { commentId: comment.id }),
        ...span(text, at, end),
      },
      end,
    };
  }

  for (const rule of config.autolinks ?? []) {
    const hit = literalRefAt(text, at, rule.prefix);
    if (hit === null) continue;
    if (!boundaryOk(text, at, WORD.test(rule.prefix[0] as string))) continue;
    return {
      token: {
        type: "autolink",
        href: rule.url_template.replace(
          "<num>",
          text.slice(at + rule.prefix.length, hit.end),
        ),
        ...span(text, at, hit.end),
      },
      end: hit.end,
    };
  }

  if (cross !== null && cross.directory !== undefined) {
    const bare = prefixedRefAt(text, at);
    if (bare !== null && boundaryOk(text, at, true)) {
      const slug = resolveClaim(
        cross.directory.entries,
        cross.directory.contested,
        bare.prefix,
        cross.at ?? new Date().toISOString(),
      );
      if (slug !== null) {
        const comment = commentSuffixAt(text, bare.end);
        const end = comment?.end ?? bare.end;
        return {
          token: {
            type: "issue",
            slug,
            number: bare.value,
            ...(comment === null ? {} : { commentId: comment.id }),
            ...span(text, at, end),
          },
          end,
        };
      }
    }
  }

  return null;
}

/** Split text into literal runs and reference tokens, in one left-to-right pass. */
export function scanReferenceTokens(
  text: string,
  config: ScanConfig,
): ReferenceToken[] {
  const cross = crossActiveAt(config.cross);
  const out: ReferenceToken[] = [];
  let pending = 0;
  let at = 0;
  while (at < text.length) {
    const claim = claimAt(text, at, config, cross);
    if (claim === null) {
      at++;
      continue;
    }
    if (claim.token !== null) {
      if (at > pending) out.push({ type: "text", ...span(text, pending, at) });
      out.push(claim.token);
      pending = claim.end;
    }
    at = claim.end;
  }
  if (pending < text.length) {
    out.push({ type: "text", ...span(text, pending, text.length) });
  }
  return out;
}
