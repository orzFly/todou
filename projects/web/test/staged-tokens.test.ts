import { describe, expect, it } from "vitest";

import {
  resolveStagedTokens,
  stagedKeysIn,
  stagedToken,
  stripStagedTokens,
  tokenInsertion,
} from "../src/lib/staged-tokens.ts";

const T1 = "![shot.png](staged:1-a)";
const T2 = "[notes.md](staged:2-a)";

/**
 * Insert `tokens` into `marked`, where `‸` is the caret or `«…»` the
 * selection, and return the result with `‸` at the new caret.
 */
function insert(marked: string, ...tokens: string[]): string {
  let doc = marked;
  let from: number;
  let to: number;
  if (doc.includes("‸")) {
    from = to = doc.indexOf("‸");
    doc = doc.replace("‸", "");
  } else {
    from = doc.indexOf("«");
    doc = doc.replace("«", "");
    to = doc.indexOf("»");
    doc = doc.replace("»", "");
  }
  const change = tokenInsertion(doc, from, to, tokens);
  const result =
    doc.slice(0, change.from) + change.insert + doc.slice(change.to);
  return `${result.slice(0, change.cursor)}‸${result.slice(change.cursor)}`;
}

const anyKey = () => true;

describe("stagedToken", () => {
  it("embeds an image and links anything else, escaping brackets", () => {
    expect(stagedToken("1-a", "shot.png", true)).toBe(T1);
    expect(stagedToken("2-a", "notes.md", false)).toBe(T2);
    expect(stagedToken("3-a", "a[1].png", true)).toBe(
      "![a\\[1\\].png](staged:3-a)",
    );
  });

  it("stays a token for a name that reads like an address", () => {
    expect(
      stagedKeysIn(stagedToken("5-a", "www.example.com.png", true), anyKey),
    ).toEqual(["5-a"]);
    expect(
      stagedKeysIn(stagedToken("6-a", "bob@example.com.pdf", false), anyKey),
    ).toEqual(["6-a"]);
  });

  it("stays a token for a name with a backslash or a backtick", () => {
    expect(stagedKeysIn(stagedToken("3-a", "a\\", true), anyKey)).toEqual([
      "3-a",
    ]);
    expect(
      stagedKeysIn(
        `${stagedToken("4-a", "x`y.png", true)} then \`code\``,
        anyKey,
      ),
    ).toEqual(["4-a"]);
  });
});

describe("tokenInsertion: inline", () => {
  it("pads the token with a space on each side mid-line", () => {
    expect(insert("ab‸cd", T1)).toBe(`ab ${T1} ‸cd`);
  });

  it("adds no space next to whitespace, a line edge or a document edge", () => {
    expect(insert("ab ‸", T1)).toBe(`ab ${T1}‸`);
    expect(insert("ab‸ cd", T1)).toBe(`ab ${T1}‸ cd`);
    expect(insert("‸ab", T1)).toBe(`${T1} ‸ab`);
    expect(insert("ab‸", T1)).toBe(`ab ${T1}‸`);
    expect(insert("x\n‸y", T1)).toBe(`x\n${T1} ‸y`);
    expect(insert("x‸\ny", T1)).toBe(`x ${T1}‸\ny`);
    expect(insert("‸", T1)).toBe(`${T1}‸`);
  });

  it("separates the tokens of one insertion with a space", () => {
    expect(insert("ab‸", T1, T2)).toBe(`ab ${T1} ${T2}‸`);
  });

  it("replaces a selection", () => {
    expect(insert("ab «XX» cd", T1)).toBe(`ab ${T1}‸ cd`);
    expect(insert("ab«XX»cd", T1)).toBe(`ab ${T1} ‸cd`);
  });

  it("stays on a quote line, in a list item and in a table cell", () => {
    expect(insert("> ab‸cd", T1)).toBe(`> ab ${T1} ‸cd`);
    expect(insert("- one\n- ab‸\n- three", T1)).toBe(
      `- one\n- ab ${T1}‸\n- three`,
    );
    expect(insert("| a | b |\n| - | - |\n| c‸d | e |", T1)).toBe(
      `| a | b |\n| - | - |\n| c ${T1} ‸d | e |`,
    );
  });

  it("moves from before a table row's leading pipe into its first cell", () => {
    expect(insert("‸| a | b |\n| - | - |\n| c | d |", T1)).toBe(
      `| ${T1} ‸a | b |\n| - | - |\n| c | d |`,
    );
  });

  it("moves from before a line's marks to the text after them", () => {
    expect(insert("‸> ab", T1)).toBe(`> ${T1} ‸ab`);
    expect(insert("‸- item", T1)).toBe(`- ${T1} ‸item`);
    expect(insert("‸# Title", T1)).toBe(`# ${T1} ‸Title`);
    expect(insert("«> ab»", T1)).toBe(`${T1}‸`);
  });

  it("moves out of inline code and past a link or a token it lands in", () => {
    expect(insert("a `co‸de` b", T1)).toBe(`a \`code\` ${T1}‸ b`);
    expect(insert("[li‸nk](https://example.com) b", T1)).toBe(
      `[link](https://example.com) ${T1}‸ b`,
    );
    expect(insert("![x](stag‸ed:9)", T1)).toBe(`![x](staged:9) ${T1}‸`);
  });

  it("keeps a selection that ends inside code and inserts after it", () => {
    expect(insert("a `co«de` b»", T1)).toBe(`a \`code\` b ${T1}‸`);
    expect(insert("«a `co»de` b", T1)).toBe(`a \`code\` ${T1}‸ b`);
  });
});

describe("tokenInsertion: after a block", () => {
  it("puts a token from inside a fence after it, in a paragraph of its own", () => {
    expect(insert("p\n\n```\nco‸de\n```\n\nq", T1)).toBe(
      `p\n\n\`\`\`\ncode\n\`\`\`\n\n${T1}‸\n\nq`,
    );
    expect(insert("```\nco‸de\n```", T1, T2)).toBe(
      `\`\`\`\ncode\n\`\`\`\n\n${T1}\n\n${T2}\n\n‸`,
    );
  });

  it("treats the fence lines themselves as the block", () => {
    expect(insert("‸```\ncode\n```\nq", T1)).toBe(
      `\`\`\`\ncode\n\`\`\`\n\n${T1}\n‸\nq`,
    );
    expect(insert("```\ncode\n```‸", T1)).toBe(
      `\`\`\`\ncode\n\`\`\`\n\n${T1}\n\n‸`,
    );
  });

  it("leaves the HTML block a token was dropped on whole", () => {
    expect(insert("<div>\na‸b\n</div>\n\nq", T1)).toBe(
      `<div>\nab\n</div>\n\n${T1}‸\n\nq`,
    );
  });

  it("leaves a table's delimiter row, a rule and a setext underline whole", () => {
    expect(insert("| a | b |\n| -‸ | - |\n| c | d |", T1)).toBe(
      `| a | b |\n| - | - |\n| c | d |\n\n${T1}\n\n‸`,
    );
    expect(insert("a\n\n---‸\n\nb", T1)).toBe(`a\n\n---\n\n${T1}‸\n\nb`);
    expect(insert("Title\n===‸", T1)).toBe(`Title\n===\n\n${T1}\n\n‸`);
  });

  it("keeps a token's own paragraph inside the quote or list item around it", () => {
    expect(insert("> | a | b |\n> | -‸ | - |\n> | c | d |", T1)).toBe(
      `> | a | b |\n> | - | - |\n> | c | d |\n>\n> ${T1}‸`,
    );
    expect(insert("- a\n- b\n  ***‸\n- c", T1)).toBe(
      `- a\n- b\n  ***\n\n  ${T1}\n‸\n- c`,
    );
    expect(insert("- a\n\n  ```\n  co‸de\n  ```\n- b", T1)).toBe(
      `- a\n\n  \`\`\`\n  code\n  \`\`\`\n\n  ${T1}\n‸\n- b`,
    );
  });

  it("does not put a token on the blank line an HTML block runs on into", () => {
    expect(insert("<div>\nx\n</div>\n‸\nnext", T1)).toBe(
      `<div>\nx\n</div>\n\n${T1}‸\n\nnext`,
    );
  });

  it("gives a token something else would swallow a paragraph of its own", () => {
    expect(insert("p\n\n    ‸", T1)).toBe(`p\n\n    \n\n${T1}\n\n‸`);
  });

  it("goes before a fence that never closes, which would swallow it", () => {
    expect(insert("p\n\n```\nco‸de", T1)).toBe(`p\n\n${T1}‸\n\n\`\`\`\ncode`);
  });
});

describe("resolveStagedTokens", () => {
  const url = "/api/projects/p/attachments/813/download/shot-813.png";
  const resolved = new Map([
    ["1-a", { url, filename: "shot-813.png", insertedName: "shot.png" }],
  ]);

  it("points the token at the upload, under the server's name", () => {
    expect(resolveStagedTokens(`a ${T1} b`, resolved)).toBe(
      `a ![shot-813.png](${url}) b`,
    );
  });

  it("keeps link text the reader rewrote", () => {
    expect(resolveStagedTokens("![the bug](staged:1-a)", resolved)).toBe(
      `![the bug](${url})`,
    );
  });

  it("resolves every place one key appears", () => {
    expect(resolveStagedTokens(`${T1}\n\n[see](staged:1-a)`, resolved)).toBe(
      `![shot-813.png](${url})\n\n[see](${url})`,
    );
  });

  it("matches a name whose brackets the token escaped", () => {
    const named = new Map([
      ["3-a", { url, filename: "a[2].png", insertedName: "a[1].png" }],
    ]);
    expect(
      resolveStagedTokens(stagedToken("3-a", "a[1].png", true), named),
    ).toBe(`![a\\[2\\].png](${url})`);
  });

  it("leaves keys it was not given, and code, alone", () => {
    expect(resolveStagedTokens(`${T2} \`${T1}\``, resolved)).toBe(
      `${T2} \`${T1}\``,
    );
  });
});

describe("stripStagedTokens", () => {
  it("takes one neighbouring space with the token", () => {
    expect(stripStagedTokens(`ab ${T1} cd`, anyKey)).toBe("ab cd");
    expect(stripStagedTokens(`ab ${T1}`, anyKey)).toBe("ab");
    expect(stripStagedTokens(`${T1} ${T2}`, anyKey)).toBe("");
  });

  it("leaves no run of more than two line breaks", () => {
    expect(stripStagedTokens(`a\n\n${T1}\n\nb`, anyKey)).toBe("a\n\nb");
  });

  it("returns a text with no token as it was, ends included", () => {
    expect(stripStagedTokens("  x \n\n\n\n y\n", anyKey)).toBe(
      "  x \n\n\n\n y\n",
    );
  });
});

describe("stagedKeysIn", () => {
  it("lists keys in order of first appearance, once each", () => {
    expect(
      stagedKeysIn("![a](staged:2-a) ![b](staged:1-a) [c](staged:2-a)", anyKey),
    ).toEqual(["2-a", "1-a"]);
  });

  it("ignores code, and counts a plain link", () => {
    expect(stagedKeysIn("`![x](staged:1-a)`", anyKey)).toEqual([]);
    expect(stagedKeysIn("```\n![x](staged:1-a)\n```", anyKey)).toEqual([]);
    expect(stagedKeysIn("[n](staged:2-a)", anyKey)).toEqual(["2-a"]);
  });

  it("ignores a key the editor never staged", () => {
    expect(stagedKeysIn("![x](staged:9-a)", (key) => key !== "9-a")).toEqual(
      [],
    );
  });

  it("answers each filter for itself on the same text", () => {
    const text = "![x](staged:9-a) ![y](staged:8-a)";
    expect(stagedKeysIn(text, anyKey)).toEqual(["9-a", "8-a"]);
    expect(stagedKeysIn(text, (key) => key !== "9-a")).toEqual(["8-a"]);
  });
});
