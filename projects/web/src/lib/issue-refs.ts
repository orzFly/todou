/**
 * #N reference tokenizer, mirroring the server's extraction regex
 * (projects/server/src/services/references.ts) so a ref that records a
 * `referenced` event is exactly a ref that renders as a link.
 */
const ISSUE_REF = /(?:^|\W)(#(\d{1,9}))\b/g;

export type RefSegment =
  | { type: "text"; value: string }
  | { type: "ref"; number: number; text: string };

/** Split plain text into literal runs and #N reference tokens. */
export function splitIssueRefs(text: string): RefSegment[] {
  const out: RefSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(ISSUE_REF)) {
    const token = match[1] as string;
    // The regex consumes the preceding non-word char; the token starts
    // after it.
    const start = match.index + match[0].length - token.length;
    if (start > last)
      out.push({ type: "text", value: text.slice(last, start) });
    out.push({ type: "ref", number: Number(match[2]), text: token });
    last = start + token.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
