import { type ScanConfig, scanReferenceTokens } from "@todou/shared";

/**
 * Rendering-side consumption of the shared reference grammar
 * (projects/shared/src/references-grammar.ts), so a ref that renders as a
 * link is exactly a ref the server records an event for. The config is
 * per-content (T-80): `internalPrefix` is the format in force when the
 * content was CREATED, `autolinks` are the project's current rules, and
 * `cross` carries what the viewer is allowed to resolve (T-150).
 */

export type RefConfig = ScanConfig;

export const DEFAULT_REF_CONFIG: RefConfig = {
  internalPrefix: null,
  autolinks: [],
};

/**
 * The self-contained spelling of another project's issue — `mirror/M-3`, or
 * `mirror#3` where it has no prefix. A bare `M-3` on a todou page reads as
 * one of *this* project's cards, so anything pointing across projects has
 * to name the project it means.
 */
export function qualifiedRefSpelling(
  slug: string,
  prefix: string | null,
  number: number,
): string {
  return `${slug}${prefix === null ? `#${number}` : `/${prefix}-${number}`}`;
}

export type RefSegment =
  | { type: "text"; value: string }
  | { type: "ref"; number: number; commentId?: number; text: string }
  | {
      type: "xref";
      slug: string;
      number: number;
      commentId?: number;
      text: string;
    }
  | { type: "comment"; commentId: number; text: string }
  | { type: "ext"; href: string; text: string };

/** Split plain text into literal runs, references, and autolinks. */
export function splitIssueRefs(
  text: string,
  config: RefConfig = DEFAULT_REF_CONFIG,
): RefSegment[] {
  const out: RefSegment[] = [];
  for (const token of scanReferenceTokens(text, config)) {
    const anchor =
      token.type === "issue" && token.commentId !== undefined
        ? { commentId: token.commentId }
        : {};
    if (token.type === "issue" && token.slug === null) {
      out.push({
        type: "ref",
        number: token.number,
        ...anchor,
        text: token.text,
      });
    } else if (token.type === "issue") {
      out.push({
        type: "xref",
        slug: token.slug as string,
        number: token.number,
        ...anchor,
        text: token.text,
      });
    } else if (token.type === "comment") {
      out.push({
        type: "comment",
        commentId: token.commentId,
        text: token.text,
      });
    } else if (token.type === "autolink") {
      out.push({ type: "ext", href: token.href, text: token.text });
    } else {
      out.push({ type: "text", value: token.text });
    }
  }
  return out;
}
