/**
 * The link layer above the reference grammar (T-266).
 *
 * References are resolved when they are submitted, and the result is stored
 * as an explicit markdown link anchored on a project id:
 * `[#12](/projects/7/issues/12)`. A project id never changes and a card that
 * moves keeps answering on its old (project, number) through the address
 * book, so a stored link never has to be rewritten again.
 *
 * This module is the pure half of that: it finds the links already in the
 * text, masks them so the token scanner cannot see inside one, and splices
 * the rewrites back in. Deciding what a candidate actually points at needs
 * the database and stays on the server.
 *
 * The rewrite is a string splice over spans, never a markdown parse: nothing
 * outside a rewritten span may differ by one byte, which a tree-and-serialize
 * round trip could not promise (T-247 review #2362).
 */

import { SLUG_PATTERN } from "./ref-shapes.ts";

const blank = (segment: string): string => segment.replace(/[^\n]/g, " ");

/**
 * `stripMarkdownCode` with the offsets kept: every character a code region
 * covers becomes a space, newlines included in place, so a scan of the mask
 * yields spans that index straight back into the original string. That is the
 * whole difference — the server's stripper drops fenced lines outright and
 * folds an inline span into a single space, which moves every offset after it.
 *
 * Widening is safe and narrowing is not, so the inline pass runs over the
 * already-blanked fences: a backtick run that now pairs across one only ever
 * masks more, and a masked token is a token left alone.
 */
export function maskMarkdownCode(text: string): string {
  const masked: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open?.[1] !== undefined) {
      const char = open[1][0] as string;
      const len = open[1].length;
      if (fence === null) {
        fence = { char, len };
        masked.push(blank(line));
        continue;
      }
      if (char === fence.char && len >= fence.len) {
        fence = null;
        masked.push(blank(line));
        continue;
      }
    }
    masked.push(fence === null ? line : blank(line));
  }
  return masked.join("\n").replace(/(`+)[^`][\s\S]*?\1/g, blank);
}

/** How a stored href names a project: by permanent id, or by a mutable slug. */
export type LinkProject =
  | { kind: "id"; id: number }
  | { kind: "slug"; slug: string };

export type AttachmentVariant = "download" | "view";

/** An address of this deployment that a link's href was written with. */
export type LinkTarget =
  | {
      kind: "issue";
      project: LinkProject;
      number: number;
      commentId?: number;
    }
  | {
      kind: "attachment";
      project: LinkProject;
      id: number;
      variant: AttachmentVariant;
      /** The cosmetic trailing segment, still percent-encoded, or null. */
      name: string | null;
    };

export type MarkdownLink = {
  /** The whole construct, image marker and brackets included. */
  start: number;
  end: number;
  /** The destination alone, so a normalisation can rewrite only that. */
  hrefStart: number;
  hrefEnd: number;
  href: string;
  /**
   * The link has no text of its own — a bare URL or an `<url>` autolink. Such
   * a link is rewritten whole, with the URL as written kept as the link text,
   * because a bare URL has no destination span to replace on its own.
   */
  bare: boolean;
  /** What of this deployment the href names, or null for anything else. */
  target: LinkTarget | null;
};

export type FindLinksOptions = {
  /**
   * The deployment's public origin. Absolute URLs are recognised as internal
   * addresses only when one is configured, because without it an absolute URL
   * naming this server is indistinguishable from one naming another.
   */
  origin?: string | undefined;
};

/**
 * Every link in the text, in source order and never overlapping.
 *
 * Code regions are masked before the scan, so a link inside a fence or an
 * inline span is not reported and therefore never rewritten. Reference-style
 * definitions (`[ref]: /projects/alpha/issues/1`) are not reported either:
 * the shape is rare and its destination sits outside any bracket pair this
 * scanner recognises, so it is kept verbatim as a known boundary.
 */
export function findMarkdownLinks(
  text: string,
  options: FindLinksOptions = {},
): MarkdownLink[] {
  return linksIn(maskMarkdownCode(text), text, options);
}

/**
 * The text with code regions and whole link constructs blanked, offsets kept.
 *
 * Masking the links is what makes the rewrite idempotent: the tokens inside
 * `[#1](/projects/1/issues/1)` — in the link text as much as in the href —
 * are invisible to the reference scanner, so a second pass over already
 * resolved text finds no candidates at all.
 *
 * Callers that already have the links pass them in; the shapes must be the
 * ones this text yields, since they index into it.
 */
export function maskForResolve(
  text: string,
  links: readonly MarkdownLink[] = findMarkdownLinks(text),
): string {
  const masked = maskMarkdownCode(text);
  if (links.length === 0) return masked;
  const pieces: string[] = [];
  let cut = 0;
  for (const link of links) {
    pieces.push(
      masked.slice(cut, link.start),
      blank(masked.slice(link.start, link.end)),
    );
    cut = link.end;
  }
  pieces.push(masked.slice(cut));
  return pieces.join("");
}

/** One span of the input replaced by `text`; everything else survives byte for byte. */
export type ResolveEdit = { start: number; end: number; text: string };

/**
 * Apply the rewrites and prove the promise the whole design rests on.
 *
 * Overlapping or out-of-range spans throw rather than produce half-rewritten
 * text: the caller assembled them from two independent scans (tokens and
 * links), and a collision there means one of the two saw something the mask
 * should have hidden. The length check catches a slicing mistake in this
 * loop, which would otherwise show up as content quietly lost.
 */
export function spliceResolved(
  text: string,
  edits: readonly ResolveEdit[],
): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let cut = 0;
  let delta = 0;
  for (const edit of ordered) {
    if (edit.end < edit.start || edit.end > text.length || edit.start < 0) {
      throw new Error(
        `resolve edit [${edit.start}, ${edit.end}) is outside the text`,
      );
    }
    if (edit.start < cut) {
      throw new Error(`resolve edits overlap at ${edit.start}`);
    }
    pieces.push(text.slice(cut, edit.start), edit.text);
    delta += edit.text.length - (edit.end - edit.start);
    cut = edit.end;
  }
  pieces.push(text.slice(cut));
  const out = pieces.join("");
  if (out.length !== text.length + delta) {
    throw new Error("resolve splice changed bytes outside its own spans");
  }
  return out;
}

/** A target the server has resolved to a current address, ready to be written. */
export type ResolvedTarget =
  | { kind: "issue"; projectId: number; number: number; commentId?: number }
  | {
      kind: "attachment";
      projectId: number;
      id: number;
      variant: AttachmentVariant;
      name: string | null;
    };

/** The canonical id-anchored href for a resolved target. */
export function hrefFor(target: ResolvedTarget): string {
  if (target.kind === "issue") {
    const anchor =
      target.commentId === undefined ? "" : `#comment-${target.commentId}`;
    return `/projects/${target.projectId}/issues/${target.number}${anchor}`;
  }
  const name = target.name === null ? "" : `/${target.name}`;
  return `/api/projects/${target.projectId}/attachments/${target.id}/${target.variant}${name}`;
}

/**
 * The stored form of a reference: the author's own spelling as the link text,
 * the permanent address as the destination. Keeping the text verbatim is what
 * lets an editor read back what they wrote, and it is why a project rename
 * never has to touch stored content.
 */
export function linkFor(target: ResolvedTarget, asTyped: string): string {
  return `[${escapeLinkText(asTyped)}](${hrefFor(target)})`;
}

/**
 * Only the characters that would end the link text early. A reference token
 * contains none of them, so this is normally a no-op; a bare URL carrying a
 * bracket is the case it exists for.
 */
function escapeLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

const ISSUE_PATH = new RegExp(
  `^/projects/(${SLUG_PATTERN})/issues/(\\d{1,9})/?$`,
);
const ATTACHMENT_PATH = new RegExp(
  `^/api/projects/(${SLUG_PATTERN})/attachments/(\\d{1,9})/(download|view)(?:/([^/]*))?$`,
);
const COMMENT_HASH = /^#comment-(\d{1,9})$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A digit run this long fits in a JavaScript number exactly, which is what a
 * project id is carried as everywhere else. Anything longer is left as a slug
 * spelling that resolves to nothing, rather than silently rounded.
 */
function projectOf(segment: string): LinkProject {
  return /^\d{1,15}$/.test(segment)
    ? { kind: "id", id: Number(segment) }
    : { kind: "slug", slug: segment };
}

/** What of this deployment an href names, or null when it names nothing here. */
export function parseInternalHref(
  href: string,
  origin?: string | undefined,
): LinkTarget | null {
  let path: string;
  let hash: string;
  if (SCHEME.test(href)) {
    if (origin === undefined) return null;
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    // A query means the href asks for something other than the resource
    // itself, and carrying it through a rewrite would change what is fetched.
    if (url.origin !== origin || url.search !== "") return null;
    path = url.pathname;
    hash = url.hash;
  } else if (href.startsWith("/") && !href.startsWith("//")) {
    if (href.includes("?")) return null;
    const at = href.indexOf("#");
    path = at === -1 ? href : href.slice(0, at);
    hash = at === -1 ? "" : href.slice(at);
  } else {
    return null;
  }

  const issue = ISSUE_PATH.exec(path);
  if (issue !== null) {
    let commentId: number | undefined;
    if (hash !== "") {
      const anchor = COMMENT_HASH.exec(hash);
      if (anchor === null) return null;
      commentId = Number(anchor[1]);
    }
    return {
      kind: "issue",
      project: projectOf(issue[1] as string),
      number: Number(issue[2]),
      ...(commentId === undefined ? {} : { commentId }),
    };
  }

  if (hash !== "") return null;
  const attachment = ATTACHMENT_PATH.exec(path);
  if (attachment === null) return null;
  return {
    kind: "attachment",
    project: projectOf(attachment[1] as string),
    id: Number(attachment[2]),
    variant: attachment[3] as AttachmentVariant,
    name: attachment[4] ?? null,
  };
}

type Found = { link: MarkdownLink; next: number };

/**
 * `scan` is the code-masked copy the shapes are found in; `source` is the
 * original the reported bytes come from. Slicing the mask instead would hand
 * back spaces for an inline code span that happens to sit inside a link.
 */
function linksIn(
  scan: string,
  source: string,
  options: FindLinksOptions,
): MarkdownLink[] {
  const found: MarkdownLink[] = [];
  let at = 0;
  while (at < scan.length) {
    const char = scan[at] as string;
    if (char === "\\") {
      at += 2;
      continue;
    }
    const hit =
      char === "<"
        ? autolinkAt(scan, source, at, options)
        : char === "[" || char === "!"
          ? inlineLinkAt(scan, source, at, options)
          : char === "h" || char === "H"
            ? bareUrlAt(scan, source, at, options)
            : null;
    if (hit === null) {
      at++;
      continue;
    }
    found.push(hit.link);
    at = hit.next;
  }
  return found;
}

function inlineLinkAt(
  scan: string,
  source: string,
  at: number,
  options: FindLinksOptions,
): Found | null {
  let open = at;
  if (scan[open] === "!") open++;
  if (scan[open] !== "[") return null;

  let depth = 0;
  let close = open;
  for (; close < scan.length; close++) {
    const char = scan[close];
    if (char === "\\") {
      close++;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (close >= scan.length || scan[close + 1] !== "(") return null;

  const destination = destinationAt(scan, close + 2);
  if (destination === null) return null;
  const href = source.slice(destination.hrefStart, destination.hrefEnd);
  return {
    link: {
      start: at,
      end: destination.end,
      hrefStart: destination.hrefStart,
      hrefEnd: destination.hrefEnd,
      href,
      bare: false,
      target: parseInternalHref(href, options.origin),
    },
    next: destination.end,
  };
}

const SPACE = /[ \t\n]/;

function destinationAt(
  scan: string,
  at: number,
): { hrefStart: number; hrefEnd: number; end: number } | null {
  let cursor = at;
  while (cursor < scan.length && SPACE.test(scan[cursor] as string)) cursor++;

  let hrefStart: number;
  let hrefEnd: number;
  if (scan[cursor] === "<") {
    hrefStart = cursor + 1;
    let end = hrefStart;
    while (end < scan.length && scan[end] !== ">" && scan[end] !== "\n") {
      if (scan[end] === "\\") end++;
      end++;
    }
    if (scan[end] !== ">") return null;
    hrefEnd = end;
    cursor = end + 1;
  } else {
    hrefStart = cursor;
    let depth = 0;
    let end = cursor;
    for (; end < scan.length; end++) {
      const char = scan[end] as string;
      if (char === "\\") {
        end++;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        if (depth === 0) break;
        depth--;
      } else if (SPACE.test(char)) break;
    }
    hrefEnd = end;
    cursor = end;
  }

  let after = cursor;
  while (after < scan.length && SPACE.test(scan[after] as string)) after++;
  if (after > cursor) {
    const quote = scan[after];
    if (quote === '"' || quote === "'" || quote === "(") {
      const closer = quote === "(" ? ")" : quote;
      let end = after + 1;
      while (end < scan.length && scan[end] !== closer) {
        if (scan[end] === "\\") end++;
        end++;
      }
      if (scan[end] !== closer) return null;
      after = end + 1;
      while (after < scan.length && SPACE.test(scan[after] as string)) after++;
    }
  }
  if (scan[after] !== ")") return null;
  return { hrefStart, hrefEnd, end: after + 1 };
}

function autolinkAt(
  scan: string,
  source: string,
  at: number,
  options: FindLinksOptions,
): Found | null {
  const close = scan.indexOf(">", at + 1);
  if (close === -1) return null;
  const inner = scan.slice(at + 1, close);
  if (!SCHEME.test(inner) || /[\s<]/.test(inner)) return null;
  const href = source.slice(at + 1, close);
  return {
    link: {
      start: at,
      end: close + 1,
      hrefStart: at + 1,
      hrefEnd: close,
      href,
      bare: true,
      target: parseInternalHref(href, options.origin),
    },
    next: close + 1,
  };
}

/** GFM starts an extended autolink only after one of these, or at the start. */
const AUTOLINK_LEFT = /[\s*_~(]/;
const TRAILING = "?!.,:*_~'\"";

function bareUrlAt(
  scan: string,
  source: string,
  at: number,
  options: FindLinksOptions,
): Found | null {
  if (!/^https?:\/\/./i.test(scan.slice(at, at + 9))) return null;
  if (at > 0 && !AUTOLINK_LEFT.test(scan[at - 1] as string)) return null;

  let end = at;
  while (end < scan.length && !/[\s<]/.test(scan[end] as string)) end++;
  // Trailing punctuation belongs to the sentence, not to the URL; a closing
  // parenthesis only does when the URL has no opening one to match it.
  while (end > at) {
    const char = scan[end - 1] as string;
    if (TRAILING.includes(char)) {
      end--;
      continue;
    }
    if (char === ")") {
      const segment = scan.slice(at, end);
      const opens = segment.split("(").length - 1;
      const closes = segment.split(")").length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  if (end <= at + 8) return null;

  const href = source.slice(at, end);
  return {
    link: {
      start: at,
      end,
      hrefStart: at,
      hrefEnd: end,
      href,
      bare: true,
      target: parseInternalHref(href, options.origin),
    },
    next: end,
  };
}
