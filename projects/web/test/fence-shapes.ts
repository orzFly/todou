/**
 * The same lines of code in every container markdown has a code block for.
 *
 * Two rules that look right read the first two of these correctly and the rest
 * wrong: taking a fence's body as the source slice minus its first and last
 * line picks up the container's indent or its `> `, and deciding whether there
 * is a marker line at all by `trimStart().startsWith("```")` misses every
 * quoted one, because `>` is not whitespace (T-343).
 */
export const FENCE_SHAPES: Array<[string, (lines: string[]) => string]> = [
  ["a top-level fence", (l) => `\`\`\`ts\n${l.join("\n")}\n\`\`\`\n`],
  ["a ~~~ fence", (l) => `~~~ts\n${l.join("\n")}\n~~~\n`],
  [
    "a fence in a list item",
    (l) => `- item\n\n  \`\`\`ts\n${prefixed(l, "  ")}\n  \`\`\`\n`,
  ],
  [
    "a fence in a blockquote",
    (l) => `> quote\n>\n> \`\`\`ts\n${prefixed(l, "> ")}\n> \`\`\`\n`,
  ],
  [
    "a fence in a nested blockquote",
    (l) => `> > \`\`\`ts\n${prefixed(l, "> > ")}\n> > \`\`\`\n`,
  ],
  [
    "an unclosed fence in a blockquote",
    (l) => `> quote\n>\n> \`\`\`ts\n${prefixed(l, "> ")}\n`,
  ],
  ["an indented code block", (l) => `para\n\n${prefixed(l, "    ")}\n`],
  [
    "an indented code block in a blockquote",
    (l) => `> para\n>\n${prefixed(l, ">     ")}\n`,
  ],
];

function prefixed(lines: string[], prefix: string): string {
  return lines.map((line) => `${prefix}${line}`).join("\n");
}
