import {
  type AutolinkRule,
  PREFIX_PATTERN,
  parseRefLocator,
  type ReferenceDirectory,
  type ReferenceToken,
  resolveClaim,
  resolveSlugAt,
  type ScanConfig,
  SLUG_PATTERN,
  scanReferenceTokens,
} from "@todou/shared";
import { parseIssuePermalink } from "@/lib/timeline-anchors.ts";

/**
 * What a search query points at, if it points at anything (T-215). The
 * search box and the results page banner both read a query through this,
 * so a pasted ref offers the same jump wherever it is pasted.
 *
 * Existence is not decided here — this says "todou 215", the query layer
 * (api/ref-jump.ts) says whether there is such a card and whether the
 * viewer may see it. Pure, so the whole matrix of spellings is testable
 * without a server.
 */

export type JumpContext = {
  /** The project the box belongs to. */
  slug: string;
  /** Its current format: null = `#N`, "T" = `T-N`. */
  prefix: string | null;
  autolinks: readonly AutolinkRule[];
  /** Slugs the viewer may name; anything else is not a candidate. */
  readableSlugs: readonly string[];
  /** Null = the cross-project grammar stays shut. */
  directory: ReferenceDirectory | null;
  /** `window.location.origin`, for recognising our own pasted URLs. */
  origin: string;
};

export type JumpCandidate =
  | {
      kind: "issue";
      slug: string;
      number: number;
      commentId?: number;
      /** The `P` of `slug/P-N`, for the query layer to check against `slug` (T-214). */
      writtenPrefix?: string;
    }
  /** A bare `#comment-M`: which issue carries it is a lookup away. */
  | { kind: "comment"; slug: string; commentId: number }
  /** A project named without a card: `ACC-`, `accel/` (T-263). */
  | { kind: "project"; slug: string }
  | { kind: "external"; href: string; text: string };

const LOCAL_TAIL = /^(\d{1,9})(?:#comment-(\d{1,9}))?$/;
const COMMENT_SUFFIX = /#comment-\d{1,9}$/;

/**
 * The canonical case of a reference: lower in the slug position, upper in the
 * prefix position. A slug is all-lower and a prefix all-upper at the schema
 * level, and the two character sets do not overlap — so the canonical
 * spelling of a string is unique and folding needs no disambiguation. It is
 * not a guess about what the reader meant, only the one spelling their
 * keystrokes could have been aiming at.
 *
 * The classes come from `ref-shapes.ts` with `i` added, so the shapes still
 * live in exactly one place. The `-$` half of the prefix lookahead is for a
 * prefix typed without a number yet (`acc-`), which names a project rather
 * than a card.
 */
const SLUG_AT = new RegExp(`^(${SLUG_PATTERN})(?=[#/])`, "i");
const PREFIX_AT = new RegExp(`^(${PREFIX_PATTERN})(?=-(?:\\d|$))`, "i");
const TAIL_PREFIX = new RegExp(`^/(${PREFIX_PATTERN})(?=-(?:\\d|$))`, "i");

export function foldRefSpelling(text: string): string {
  // Qualified before bare, the order `claimAt` resolves them in.
  const slug = SLUG_AT.exec(text);
  if (slug !== null) {
    const head = (slug[1] as string).toLowerCase();
    const rest = text.slice(head.length);
    const tail = TAIL_PREFIX.exec(rest);
    return tail === null
      ? head + rest
      : `${head}/${(tail[1] as string).toUpperCase()}${rest.slice(
          (tail[1] as string).length + 1,
        )}`;
  }
  const prefix = PREFIX_AT.exec(text);
  if (prefix !== null) {
    const head = (prefix[1] as string).toUpperCase();
    return head + text.slice(head.length);
  }
  return text;
}

/** `ACC-`, `accel/`, `accel#`, `accel/#` — a project, and no card in it. */
const PROJECT_BY_PREFIX = new RegExp(`^(${PREFIX_PATTERN})-$`);
const PROJECT_BY_SLUG = new RegExp(`^(${SLUG_PATTERN})(?:#|/#?)$`);

/**
 * Does this name a project without naming a card? Asked before the directory
 * has been read, so `couldBeRef`'s "ends in digits" test — which is about
 * cards — cannot answer it and Enter needs its own.
 */
export function couldNameProject(q: string): boolean {
  const text = foldRefSpelling(q.trim());
  return PROJECT_BY_PREFIX.test(text) || PROJECT_BY_SLUG.test(text);
}

/**
 * The project a whole query names, if that is all it does (T-263). Folded
 * unconditionally: unlike a card spelling there is no original reading to
 * preserve, since none of these shapes resolves to anything today.
 *
 * Both resolvers are the shared grammar's own, so a contested prefix stays
 * unresolved and a project the viewer cannot read never reaches a query —
 * no new parser, and no new way to learn that a project exists.
 */
function projectAt(text: string, ctx: JumpContext): JumpCandidate | null {
  const directory = ctx.directory;
  // Shut directory, shut grammar: `mirror/1` does not resolve either, so
  // `mirror/` has nothing to be.
  if (directory === null) return null;
  const now = new Date().toISOString();

  const qualified = PROJECT_BY_SLUG.exec(text);
  if (qualified !== null) {
    const slug = resolveSlugAt(
      // Absent on a pre-T-156 server, where `resolveSlugAt` falls back to
      // the live slugs on its own.
      directory.slug_entries ?? [],
      ctx.readableSlugs,
      qualified[1] as string,
      now,
    );
    return slug === null ? null : { kind: "project", slug };
  }

  const prefixed = PROJECT_BY_PREFIX.exec(text);
  if (prefixed !== null) {
    const slug = resolveClaim(
      directory.entries,
      directory.contested,
      prefixed[1] as string,
      now,
    );
    return slug === null ? null : { kind: "project", slug };
  }
  return null;
}

/**
 * This project's own card, spelled the way a search box receives it: a bare
 * number, `#N` whatever the format is now, and the current token in either
 * case.
 *
 * The shared grammar cannot answer this rung. It matches the token
 * case-sensitively, as prose must — `some-t-215` in a sentence is not a
 * reference — and once the format is `T-` it reads `#215` as an autolink or
 * as text. A box is not prose: `t-215` typed without reaching for shift
 * means the card, and `refShortcut` read both that and the bare number
 * before this (T-141), so the box must not narrow.
 */
function localRefAt(
  text: string,
  prefix: string | null,
): { number: number; commentId?: number } | null {
  const token = prefix === null ? "#" : `${prefix}-`;
  const rest =
    text.slice(0, token.length).toLowerCase() === token.toLowerCase()
      ? text.slice(token.length)
      : text.startsWith("#")
        ? text.slice(1)
        : text;
  const match = LOCAL_TAIL.exec(rest);
  if (match === null) return null;
  const number = Number(match[1]);
  // Leading zeros and all: `007` is issue 7, `0` is no issue at all.
  if (number <= 0) return null;
  const commentId = match[2];
  return {
    number,
    ...(commentId === undefined ? {} : { commentId: Number(commentId) }),
  };
}

function scanConfigOf(ctx: JumpContext): ScanConfig {
  const base = { internalPrefix: ctx.prefix, autolinks: ctx.autolinks };
  const directory = ctx.directory;
  if (directory === null) return base;
  return {
    ...base,
    cross: {
      slugs: ctx.readableSlugs,
      directory: {
        entries: directory.entries,
        contested: directory.contested,
      },
      // Absent on a pre-T-156 server, where an empty list reads the same.
      slugEntries: directory.slug_entries ?? [],
      // No `at`: a box resolves what the spelling means now, not what it
      // would have meant when some text was written.
    },
  };
}

/**
 * The one reference this query is, or nothing. A box hands over a whole
 * thing or a search: `T-215 折行` is a query with a word in it, not a
 * reference with noise attached.
 */
function wholeToken(text: string, ctx: JumpContext): ReferenceToken | null {
  const tokens = scanReferenceTokens(text, scanConfigOf(ctx));
  const only = tokens.length === 1 ? tokens[0] : undefined;
  if (only === undefined || only.type === "text") return null;
  return only.start === 0 && only.end === text.length ? only : null;
}

function writtenPrefixOf(text: string): { writtenPrefix?: string } {
  // The comment anchor is not part of a locator, and the prefix it hides
  // still has to be checked, so it comes off first.
  const locator = parseRefLocator(text.replace(COMMENT_SUFFIX, ""));
  return locator?.kind === "qualified" && locator.prefix !== null
    ? { writtenPrefix: locator.prefix }
    : {};
}

/**
 * Zero leakage (T-150): a candidate naming a project outside the viewer's
 * reach never becomes a query, so "unreadable" and "no such card" are the
 * same missing row. The grammar already drops a qualified form naming one;
 * a pasted URL and a bare foreign prefix arrive here on trust.
 */
function readableOnly(
  candidates: JumpCandidate[],
  ctx: JumpContext,
): JumpCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.kind === "external" ||
      ctx.readableSlugs.includes(candidate.slug),
  );
}

/**
 * Could this be a reference at all, before the project's format is known?
 * Every shape in the grammar ends in digits and holds no whitespace, so a
 * query failing either test cannot resolve to anything.
 *
 * Which is what lets Enter skip waiting on the context for an ordinary
 * search: the box asks nothing until it is typed in, so on the first
 * keystroke "nothing resolved yet" and "not a reference" look alike, and
 * only this tells them apart without a round trip.
 */
export function couldBeRef(q: string): boolean {
  const text = q.trim();
  return text !== "" && !/\s/.test(text) && /\d/.test(text);
}

/**
 * At most two candidates: one card and one external link, in that order.
 * Both appear together when `#` is this project's autolink prefix while
 * `T-` is its format — the setup docs/external-trackers.md recommends for a
 * GitHub mirror — where `#76` reads equally well as either, and choosing
 * for the reader would be a guess.
 */
export function refJumpCandidates(
  q: string,
  ctx: JumpContext,
): JumpCandidate[] {
  const text = q.trim();

  const project = projectAt(foldRefSpelling(text), ctx);
  if (project !== null) return readableOnly([project], ctx);

  if (!couldBeRef(text)) return [];

  if (/^https?:\/\//i.test(text)) {
    const link = parseIssuePermalink(text, ctx.origin);
    // Someone else's URL is a URL. Falling through to scan it as text would
    // offer a card for whatever digits its path happens to carry.
    return link === null ? [] : readableOnly([{ kind: "issue", ...link }], ctx);
  }

  const out: JumpCandidate[] = [];
  const local = localRefAt(text, ctx.prefix);
  if (local !== null) out.push({ kind: "issue", slug: ctx.slug, ...local });

  // Folding is a fallback, never an override: a spelling that resolves as
  // written keeps resolving to exactly what it did, and `writtenPrefixOf`
  // reads the string that produced the token. So every query that jumps
  // somewhere today jumps to the same place, and folding only fills in
  // where nothing was offered at all.
  const written = wholeToken(text, ctx);
  const folded = written === null ? foldRefSpelling(text) : text;
  const token = written ?? wholeToken(folded, ctx);
  if (token?.type === "autolink") {
    out.push({ kind: "external", href: token.href, text: token.text });
  } else if (out.length === 0 && token?.type === "issue") {
    out.push({
      kind: "issue",
      slug: token.slug ?? ctx.slug,
      number: token.number,
      ...(token.commentId === undefined ? {} : { commentId: token.commentId }),
      ...writtenPrefixOf(folded),
    });
  } else if (out.length === 0 && token?.type === "comment") {
    out.push({ kind: "comment", slug: ctx.slug, commentId: token.commentId });
  }

  return readableOnly(out, ctx);
}
