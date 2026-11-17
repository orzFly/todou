/**
 * What counts as an author's image pair (T-767), shared by the renderer's and
 * the editor's tests so one paragraph gets one answer on both sides. Each case
 * is a whole document; `pair` says whether any paragraph in it is a pair.
 */
export type ImagePairCase = { name: string; markdown: string; pair: boolean };

const A = "![a](/x.png)";
const B = "![b](/y.png)";

export const IMAGE_PAIR_CASES: ImagePairCase[] = [
  { name: "→", markdown: `${A} → ${B}\n`, pair: true },
  { name: "->", markdown: `${A} -> ${B}\n`, pair: true },
  { name: "no spaces", markdown: `${A}→${B}\n`, pair: true },
  { name: "soft breaks around →", markdown: `${A}\n→\n${B}\n`, pair: true },
  { name: "soft break before ->", markdown: `${A}\n-> ${B}\n`, pair: true },
  { name: "in a blockquote", markdown: `> ${A} → ${B}\n`, pair: true },
  {
    name: "in a blockquote across lines",
    markdown: `> ${A}\n> → ${B}\n`,
    pair: true,
  },
  { name: "tight list item", markdown: `- ${A} → ${B}\n- next\n`, pair: true },
  {
    name: "loose list item",
    markdown: `- ${A} → ${B}\n\n- next\n`,
    pair: true,
  },
  {
    name: "list item across lines",
    markdown: `- ${A}\n  → ${B}\n`,
    pair: true,
  },
  {
    name: "among other paragraphs",
    markdown: `Before.\n\n${A} -> ${B}\n\nAfter.\n`,
    pair: true,
  },
  { name: "in a sentence", markdown: `see ${A} → ${B} here\n`, pair: false },
  { name: "text after", markdown: `${A} → ${B} here\n`, pair: false },
  {
    name: "three images",
    markdown: `${A} → ${B} → ![c](/z.png)\n`,
    pair: false,
  },
  { name: "two images, no arrow", markdown: `${A} ${B}\n`, pair: false },
  { name: "<-", markdown: `${A} <- ${B}\n`, pair: false },
  { name: "=>", markdown: `${A} => ${B}\n`, pair: false },
  { name: "double arrow", markdown: `${A} → → ${B}\n`, pair: false },
  { name: "bold around one", markdown: `**${A}** → ${B}\n`, pair: false },
  { name: "linked image", markdown: `[${A}](/l) → ${B}\n`, pair: false },
  {
    name: "table cell",
    markdown: `| x |\n| - |\n| ${A} → ${B} |\n`,
    pair: false,
  },
  { name: "inline code", markdown: `\`${A} → ${B}\`\n`, pair: false },
  { name: "fence", markdown: `\`\`\`\n${A} → ${B}\n\`\`\`\n`, pair: false },
  {
    name: "two paragraphs",
    markdown: `${A}\n\n→ ${B}\n`,
    pair: false,
  },
];
