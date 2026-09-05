/**
 * Respell a moved card's own references so the text keeps meaning what it
 * meant (T-247).
 *
 * A bare `#12` written while the card lived in `homelab` denotes homelab/12
 * forever. Reading it under the destination's numbering silently lands on a
 * different card, so the move rewrites those spellings once — `homelab#12`
 * names its project outright and is therefore immune to every later move.
 *
 * The rewrite is a string splice over the scanner's own spans, never a
 * markdown parse: nothing outside a rewritten span may differ by one byte,
 * which a tree-and-serialize round trip could not promise.
 */

import {
  type ReferenceToken,
  type ScanConfig,
  scanReferenceTokens,
} from "./references-grammar.ts";

export type RespellInputs = {
  /** The grammar as it stood in the project that owned the text when it was written. */
  anchor: ScanConfig;
  /** The origin's current canonical slug: what the qualified form is spelled with. */
  originSlug: string;
  /**
   * This card's own comments, old id → new.
   *
   * Only for text that has not been respelled yet: nothing in `#comment-2`
   * says whether that 2 was written at the old address or the new one, and
   * each project database numbers comments from its own sequence, so the two
   * readings really do collide. A caller with no un-respelled promise to make
   * leaves this out and spells the card's own anchors through
   * `foreignCommentIssue` instead, whose form no later pass touches.
   */
  commentIdMap?: ReadonlyMap<number, number>;
  /**
   * Comment ids → the origin card number they live on, for anchors the new
   * address cannot spell bare: another of the origin's cards, or this card's
   * own former ids when the caller cannot promise the text is un-respelled.
   */
  foreignCommentIssue?: ReadonlyMap<number, number>;
};

export type RespellResult = {
  text: string;
  changed: boolean;
  /** The rewrite was abandoned whole, so `text` is the input byte for byte. */
  skipped: boolean;
  /** Tokens respelled — 0 whenever `changed` is false. */
  rewritten: number;
};

type RefToken = Exclude<ReferenceToken, { type: "text" }>;

/** What a token has to resolve to afterwards; the fixed-point check compares these. */
type Target =
  | {
      kind: "issue";
      slug: string | null;
      number: number;
      commentId: number | undefined;
    }
  | { kind: "comment"; commentId: number }
  | { kind: "autolink"; href: string };

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

function refTokens(text: string, anchor: ScanConfig): RefToken[] {
  return scanReferenceTokens(maskMarkdownCode(text), anchor).filter(
    (token): token is RefToken => token.type !== "text",
  );
}

function targetOf(token: RefToken): Target {
  switch (token.type) {
    case "issue":
      return {
        kind: "issue",
        slug: token.slug,
        number: token.number,
        commentId: token.commentId,
      };
    case "comment":
      return { kind: "comment", commentId: token.commentId };
    case "autolink":
      return { kind: "autolink", href: token.href };
  }
}

function sameTarget(a: Target, b: Target): boolean {
  if (a.kind === "issue" && b.kind === "issue") {
    return (
      a.slug === b.slug && a.number === b.number && a.commentId === b.commentId
    );
  }
  if (a.kind === "comment" && b.kind === "comment") {
    return a.commentId === b.commentId;
  }
  if (a.kind === "autolink" && b.kind === "autolink") return a.href === b.href;
  return false;
}

/**
 * The project `originSlug#1` actually names under this anchor, asked of the
 * scanner rather than re-derived.
 *
 * Anything but the origin itself means the qualified form cannot be written
 * here: a slug another project held at that instant would resolve to that
 * project, which would turn a meaning-preserving rewrite into a wrong
 * reference. It is caught before a single span moves.
 */
function resolvesToOrigin(inputs: RespellInputs): boolean {
  for (const token of scanReferenceTokens(
    `${inputs.originSlug}#1`,
    inputs.anchor,
  )) {
    if (token.type === "issue" && token.number === 1) {
      return token.slug === inputs.originSlug;
    }
  }
  return false;
}

type Respelt = { text: string; target: Target };

/** null = leave the token as written. */
function respellToken(token: RefToken, inputs: RespellInputs): Respelt | null {
  const { originSlug } = inputs;
  if (token.type === "issue") {
    // A qualified form, an autolink and another project's bare prefix all name
    // their project outright, so no move can change what they mean. The
    // comment suffix rides along untouched for the same reason: `origin#N` is
    // the card's old address, and its comment ids are what that address holds.
    if (token.slug !== null) return null;
    const suffix =
      token.commentId === undefined ? "" : `#comment-${token.commentId}`;
    return {
      text: `${originSlug}#${token.number}${suffix}`,
      target: {
        kind: "issue",
        slug: originSlug,
        number: token.number,
        commentId: token.commentId,
      },
    };
  }
  if (token.type !== "comment") return null;

  const moved = inputs.commentIdMap?.get(token.commentId);
  if (moved !== undefined) {
    if (moved === token.commentId) return null;
    return {
      text: `#comment-${moved}`,
      target: { kind: "comment", commentId: moved },
    };
  }
  const card = inputs.foreignCommentIssue?.get(token.commentId);
  if (card === undefined) return null;
  return {
    text: `${originSlug}#${card}#comment-${token.commentId}`,
    target: {
      kind: "issue",
      slug: originSlug,
      number: card,
      commentId: token.commentId,
    },
  };
}

/**
 * Rewrite one segment of content — an issue body, a comment, one spec file.
 *
 * The output is re-scanned under the same anchor and compared token for token
 * against what each rewrite claimed it would mean. A spelling the grammar
 * would no longer see (a qualified form landing behind a hyphen, which the
 * bare form was allowed to follow and this one is not) fails that check, and a
 * segment that fails is returned untouched: half-respelled text is worse than
 * text nobody rewrote.
 */
export function respellForMove(
  text: string,
  inputs: RespellInputs,
): RespellResult {
  const kept: RespellResult = {
    text,
    changed: false,
    skipped: false,
    rewritten: 0,
  };
  const abandoned: RespellResult = {
    text,
    changed: false,
    skipped: true,
    rewritten: 0,
  };

  const tokens = refTokens(text, inputs.anchor);
  if (tokens.length === 0) return kept;
  if (!resolvesToOrigin(inputs)) return abandoned;

  const pieces: string[] = [];
  const expected: Target[] = [];
  let cut = 0;
  let rewritten = 0;
  for (const token of tokens) {
    const respelt = respellToken(token, inputs);
    expected.push(respelt === null ? targetOf(token) : respelt.target);
    if (respelt === null) continue;
    pieces.push(text.slice(cut, token.start), respelt.text);
    cut = token.end;
    rewritten += 1;
  }
  if (rewritten === 0) return kept;
  pieces.push(text.slice(cut));

  const out = pieces.join("");
  const after = refTokens(out, inputs.anchor);
  if (after.length !== expected.length) return abandoned;
  for (const [index, token] of after.entries()) {
    if (!sameTarget(targetOf(token), expected[index] as Target)) {
      return abandoned;
    }
  }
  return { text: out, changed: true, skipped: false, rewritten };
}
