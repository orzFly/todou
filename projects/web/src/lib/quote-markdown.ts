/**
 * Turning a comment or an issue body into the markdown a reply quotes it
 * with. Everything here works on the stored source, never on rendered text:
 * bold, links and code fences have to survive into the quote.
 */

/**
 * Every line prefixed. Blank lines become a bare `>` so the whole passage
 * stays one quote block instead of breaking into several at the gaps.
 */
export function blockquote(body: string): string {
  return body
    .trimEnd()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** 1-based inclusive source lines, clamped to both ends of the body. */
export function sourceLines(body: string, start: number, end: number): string {
  const lines = body.split("\n");
  return lines
    .slice(Math.max(0, start - 1), Math.min(lines.length, end))
    .join("\n");
}

/**
 * Quoted content plus where it came from. The attribution is a bare absolute
 * URL because that is the only shape the renderer draws as a rich reference
 * and the only one the server's resolve pass records a reference event for
 * (see `parseIssuePermalink`).
 */
export function quotedReference(input: {
  body: string;
  authorLogin: string;
  permalink: string;
}): string {
  return `${blockquote(input.body)}\n\n_Originally posted by @${input.authorLogin} in ${input.permalink}_`;
}
