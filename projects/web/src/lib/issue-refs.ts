import { type ScanConfig, scanReferenceTokens } from "@todou/shared";

/**
 * Rendering-side consumption of the shared reference grammar
 * (projects/shared/src/references-grammar.ts), so a ref that renders as a
 * link is exactly a ref the server records an event for. The config is
 * per-content (T-80): `internalPrefix` is the format in force when the
 * content was CREATED, `autolinks` are the project's current rules.
 */

export type RefConfig = ScanConfig;

export const DEFAULT_REF_CONFIG: RefConfig = {
  internalPrefix: null,
  autolinks: [],
};

export type RefSegment =
  | { type: "text"; value: string }
  | { type: "ref"; number: number; text: string }
  | { type: "ext"; href: string; text: string };

/** Split plain text into literal runs, internal refs, and autolinks. */
export function splitIssueRefs(
  text: string,
  config: RefConfig = DEFAULT_REF_CONFIG,
): RefSegment[] {
  const out: RefSegment[] = [];
  for (const token of scanReferenceTokens(text, config)) {
    if (token.type === "issue" && token.slug === null) {
      out.push({ type: "ref", number: token.number, text: token.text });
    } else if (token.type === "autolink") {
      out.push({ type: "ext", href: token.href, text: token.text });
    } else {
      out.push({ type: "text", value: token.text });
    }
  }
  return out;
}
