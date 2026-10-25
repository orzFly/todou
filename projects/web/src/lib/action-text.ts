/**
 * An action's text as markdown that can only render inline (T-575). The line
 * is stored as typed, so `/me - checks the list` or `/me 1. reads the spec`
 * would otherwise come back as a list item, and `/me # heading` as a heading:
 * a block where the reader expects the rest of a sentence. Escaping the one
 * marker that opens the line keeps its characters on screen and leaves
 * everything inline — code, links, references — as it was.
 */
export function inlineActionSource(text: string): string {
  const ordered = /^(\d{1,9})([.)])(?=\s|$)/.exec(text);
  if (ordered !== null) {
    return `${ordered[1]}\\${ordered[2]}${text.slice(ordered[0].length)}`;
  }
  // Headings, quotes, bullets, fences and thematic breaks: each opens on its
  // first character, which a backslash turns back into text.
  if (
    /^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|`{3}|~{3}|(?<rule>[-*_])(?:\s*\k<rule>){2,}\s*$)/.test(
      text,
    )
  ) {
    return `\\${text}`;
  }
  return text;
}
