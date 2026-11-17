export type MermaidFence = {
  /** 1-based line, in the whole document, of the block's first content line. */
  startLine: number;
  source: string;
};

// Leading spaces are not capped at three, and a list marker may precede the
// fence: a fence inside a list item sits at the item's content indent, which
// is past three spaces as soon as lists nest. Blockquotes (`>`) are not
// followed — a known miss.
const OPEN = /^( *(?:(?:[-*+]|\d{1,9}[.)]) +)?)(`{3,}|~{3,})(.*)$/;

/**
 * Every fenced block whose info string names mermaid, by CommonMark's fence
 * rules. Other fences are tracked too, so that a mermaid fence shown inside
 * a markdown example is not taken for a real one.
 *
 * The tag is matched case-sensitively, as the web's markdown view does: a
 * ```` ```Mermaid ```` block renders there as plain code, which cannot fail.
 */
export function findMermaidFences(text: string): MermaidFence[] {
  const lines = text.split(/\r?\n/);
  const found: MermaidFence[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = OPEN.exec(lines[i]);
    i += 1;
    if (open === null) continue;
    const [, prefix, marker, info] = open;
    // A backtick fence's info string cannot hold a backtick; such a line is
    // an inline code span, not a fence.
    if (marker[0] === "`" && info.includes("`")) continue;
    const indent = prefix.length;
    const close = new RegExp(
      `^ *${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`,
    );
    const body: string[] = [];
    const start = i + 1;
    while (i < lines.length && !close.test(lines[i])) {
      body.push(stripIndent(lines[i], indent));
      i += 1;
    }
    i += 1;
    if (info.trim().split(/\s+/)[0] === "mermaid") {
      found.push({ startLine: start, source: body.join("\n") });
    }
  }
  return found;
}

function stripIndent(line: string, indent: number): string {
  let n = 0;
  while (n < indent && line[n] === " ") n += 1;
  return line.slice(n);
}
