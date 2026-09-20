export type CommentRefPart = {
  /**
   * `free` is a whole token nobody could take apart — what a search row shows
   * for a project, an external link or a peeked card. It shrinks like a slug
   * does, because a token that never shrinks is the failure itself (T-446).
   */
  kind: "slug" | "prefix" | "fixed" | "free";
  text: string;
};

/** Only split a recognized spelling. An unfamiliar spelling stays lossless. */
export function splitCommentIssueRef(
  spelled: string,
  slug: string,
  prefix: string | null,
  number: number,
): CommentRefPart[] {
  const local = prefix === null ? `#${number}` : `${prefix}-${number}`;
  const qualified = `${slug}${prefix === null ? "" : "/"}${local}`;
  if (spelled !== local && spelled !== qualified) {
    return [{ kind: "fixed", text: spelled }];
  }
  const parts: CommentRefPart[] = [];
  if (spelled === qualified) {
    parts.push({ kind: "slug", text: slug });
    if (prefix !== null) parts.push({ kind: "fixed", text: "/" });
  }
  if (prefix !== null) parts.push({ kind: "prefix", text: prefix });
  parts.push({
    kind: "fixed",
    text: `${prefix === null ? "#" : "-"}${number}`,
  });
  return parts;
}

/** Which card a spelling names, where the renderer knows that much. */
export type RefIdentity = {
  slug: string;
  prefix: string | null;
  number: number;
  commentId?: number;
};

/**
 * A ref token as allocation parts, for a caller holding one string and
 * whatever it knows about the card behind it.
 *
 * Two things separate this from `splitCommentIssueRef`. The comment suffix
 * travels inside the spelling here rather than beside it, and a spelling the
 * decomposition does not recognize becomes one elidable run instead of an
 * immovable one — a search row offering an external link or a project has no
 * card to decompose, and leaving those tokens rigid is the T-446 report.
 */
export function refTokenParts(
  spelled: string,
  identity: RefIdentity | null,
): CommentRefPart[] {
  if (identity === null) return [{ kind: "free", text: spelled }];
  const suffix =
    identity.commentId === undefined ? "" : `#comment-${identity.commentId}`;
  const carried = suffix !== "" && spelled.endsWith(suffix);
  const base = carried ? spelled.slice(0, -suffix.length) : spelled;
  const parts = splitCommentIssueRef(
    base,
    identity.slug,
    identity.prefix,
    identity.number,
  );
  const head: CommentRefPart[] =
    parts.length === 1 && parts[0].kind === "fixed"
      ? [{ kind: "free", text: base }]
      : parts;
  return carried ? [...head, { kind: "fixed", text: suffix }] : head;
}

export type RefSegmentWidth = {
  /** Width of the complete original segment, measured in CSS pixels. */
  full: number;
  /** First character + native ellipsis + last character (or full if shorter). */
  minimum: number;
};

export type CommentRefAllocation = {
  widths: number[];
  wrap: boolean;
};

/**
 * Water-fill the segment budget by CSS width. Short segments return their
 * unused half; a segment with unusually wide end glyphs retains its minimum.
 * Fixed separators, issue digits and the entire comment suffix never shrink.
 */
export function allocateCommentRef(
  available: number,
  fixed: number,
  segments: readonly RefSegmentWidth[],
): CommentRefAllocation {
  const minima = segments.map(({ full, minimum }) =>
    Math.max(0, Math.min(full, minimum)),
  );
  const budget = Math.max(0, available - fixed);
  if (fixed + minima.reduce((sum, width) => sum + width, 0) > available) {
    return { widths: minima, wrap: true };
  }
  if (segments.reduce((sum, { full }) => sum + full, 0) <= budget) {
    return { widths: segments.map(({ full }) => full), wrap: false };
  }
  // Find the common width with each segment clamped to [minimum, full].
  let low = 0;
  let high = Math.max(0, ...segments.map(({ full }) => full));
  for (let iteration = 0; iteration < 48; iteration++) {
    const share = (low + high) / 2;
    const total = segments.reduce(
      (sum, { full }, index) =>
        sum + Math.max(minima[index], Math.min(full, share)),
      0,
    );
    if (total > budget) high = share;
    else low = share;
  }
  return {
    widths: segments.map(({ full }, index) =>
      Math.max(minima[index], Math.min(full, low)),
    ),
    wrap: false,
  };
}
