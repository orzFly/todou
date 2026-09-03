import {
  type AutolinkRule,
  parseRefLocator,
  type ReferenceDirectory,
  type ReferenceToken,
  type ScanConfig,
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
  /** Null, or `since: null`, = the cross-project grammar stays shut. */
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
  | { kind: "external"; href: string; text: string };

const LOCAL_TAIL = /^(\d{1,9})(?:#comment-(\d{1,9}))?$/;
const COMMENT_SUFFIX = /#comment-\d{1,9}$/;

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
  if (directory === null || directory.since === null) return base;
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
      since: directory.since,
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
  if (text === "") return [];

  if (/^https?:\/\//i.test(text)) {
    const link = parseIssuePermalink(text, ctx.origin);
    // Someone else's URL is a URL. Falling through to scan it as text would
    // offer a card for whatever digits its path happens to carry.
    return link === null ? [] : readableOnly([{ kind: "issue", ...link }], ctx);
  }

  const out: JumpCandidate[] = [];
  const local = localRefAt(text, ctx.prefix);
  if (local !== null) out.push({ kind: "issue", slug: ctx.slug, ...local });

  const token = wholeToken(text, ctx);
  if (token?.type === "autolink") {
    out.push({ kind: "external", href: token.href, text: token.text });
  } else if (out.length === 0 && token?.type === "issue") {
    out.push({
      kind: "issue",
      slug: token.slug ?? ctx.slug,
      number: token.number,
      ...(token.commentId === undefined ? {} : { commentId: token.commentId }),
      ...writtenPrefixOf(text),
    });
  } else if (out.length === 0 && token?.type === "comment") {
    out.push({ kind: "comment", slug: ctx.slug, commentId: token.commentId });
  }

  return readableOnly(out, ctx);
}
