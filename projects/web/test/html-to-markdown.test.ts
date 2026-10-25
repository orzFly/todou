import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "../src/lib/paste/html-to-markdown.ts";

/** What Chrome puts on the clipboard for a selection on a page. */
function chrome(fragment: string): string {
  return `<html>\n<body>\n<!--StartFragment-->${fragment}<!--EndFragment-->\n</body>\n</html>`;
}

const HTML = ["text/plain", "text/html"];

describe("htmlToMarkdown", () => {
  it("turns a Chrome page selection into Markdown with its links", () => {
    const result = htmlToMarkdown({
      html: chrome(
        '<p style="color: rgb(0, 0, 0);">See <a href="https://example.com/a">the guide</a> first.</p><p>Then <strong>run</strong> it.</p>',
      ),
      plain: "See the guide first.\n\nThen run it.",
      types: HTML,
    });
    expect(result).toEqual({
      markdown:
        "See [the guide](https://example.com/a) first.\n\nThen **run** it.",
      codeLike: false,
      inline: false,
    });
  });

  it("drops the StartFragment comments and head furniture", () => {
    const result = htmlToMarkdown({
      html: `<html><head><meta charset="utf-8"><style>p{}</style></head><body><!--StartFragment--><h2>Heading</h2><p>body</p><!--EndFragment--></body></html>`,
      plain: "Heading\nbody",
      types: HTML,
    });
    expect(result.markdown).toBe("## Heading\n\nbody");
  });

  it("reads Google Docs' styled spans and ignores its docs-internal-guid wrapper", () => {
    const result = htmlToMarkdown({
      html: '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-0a1b2c3d-7fff-1234-5678-9abcdef01234"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;font-style:normal;">plain </span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:700;font-style:normal;">bold</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;font-style:italic;"> slanted</span></p><br><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;font-weight:400;font-style:normal;">second</span></p></b>',
      plain: "plain bold slanted\n\nsecond",
      types: HTML,
    });
    expect(result.markdown).toBe("plain **bold** _slanted_\n\nsecond");
  });

  it("treats VS Code's copy as code, fenced with its language", () => {
    const plain = "const a = 1;\n\nconst b = 2;";
    const result = htmlToMarkdown({
      html: '<meta charset=\'utf-8\'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, \'Courier New\', monospace;font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;"><div><span style="color: #569cd6;">const</span><span style="color: #cccccc;"> </span><span style="color: #4fc1ff;">a</span><span style="color: #cccccc;"> = </span><span style="color: #b5cea8;">1</span><span style="color: #cccccc;">;</span></div><br><div><span style="color: #569cd6;">const</span><span style="color: #cccccc;"> b = 2;</span></div></div>',
      plain,
      types: ["text/plain", "text/html", "vscode-editor-data"],
      vscodeEditorData: JSON.stringify({
        version: 1,
        isFromEmptySelection: false,
        multicursorText: null,
        mode: "typescript",
      }),
    });
    expect(result).toEqual({
      markdown: "```typescript\nconst a = 1;\n\nconst b = 2;\n```",
      codeLike: true,
      inline: false,
    });
  });

  it("treats a white-space: pre copy as code without any clipboard type saying so", () => {
    const result = htmlToMarkdown({
      html: '<pre style="background-color:#ffffff;color:#080808;font-family:\'JetBrains Mono\',monospace;font-size:9.8pt;"><span style="color:#0033b3;">val </span><span style="color:#000000;">x </span>= <span style="color:#1750eb;">1</span><br>println(x)</pre>',
      plain: "val x = 1\nprintln(x)",
      types: HTML,
    });
    expect(result.codeLike).toBe(true);
    expect(result.markdown).toBe("```\nval x = 1\nprintln(x)\n```");

    const styled = htmlToMarkdown({
      html: '<div style="white-space: pre-wrap; font-family: monospace;">$ ls\nREADME.md</div>',
      plain: "$ ls\nREADME.md",
      types: HTML,
    });
    expect(styled.codeLike).toBe(true);
  });

  it("does not call a page code-like because one block of it is", () => {
    const result = htmlToMarkdown({
      html: chrome("<p>Run this:</p><pre><code>make</code></pre>"),
      plain: "Run this:\nmake",
      types: HTML,
    });
    expect(result.codeLike).toBe(false);
    expect(result.markdown).toBe("Run this:\n\n```\nmake\n```");
  });

  it("offers no Markdown for a single-line <h1>", () => {
    const result = htmlToMarkdown({
      html: chrome("<h1>Release notes</h1>"),
      plain: "Release notes",
      types: HTML,
    });
    expect(result).toEqual({ markdown: null, codeLike: false, inline: true });
  });

  it("keeps a one-line heading's link but not its #", () => {
    const result = htmlToMarkdown({
      html: chrome(
        '<h2>Read <a href="https://example.com/x">x</a> <em>now</em></h2>',
      ),
      plain: "Read x now",
      types: HTML,
    });
    expect(result).toEqual({
      markdown: "Read [x](https://example.com/x) _now_",
      codeLike: false,
      inline: true,
    });
  });

  it("flattens a one-line selection spanning blocks into one run", () => {
    const result = htmlToMarkdown({
      html: chrome("<ul><li><strong>one</strong></li></ul><pre>two</pre>"),
      plain: "one two",
      types: HTML,
    });
    expect(result.markdown).toBe("**one** `two`");
  });

  it("offers no Markdown for paragraphs that are only text", () => {
    const result = htmlToMarkdown({
      html: chrome("<p>first</p><p>second</p>"),
      plain: "first\n\nsecond",
      types: HTML,
    });
    expect(result.markdown).toBeNull();
  });

  it("offers no Markdown for a paragraph broken with <br>", () => {
    const result = htmlToMarkdown({
      html: chrome("<p>line one<br>line two</p>"),
      plain: "line one\nline two",
      types: HTML,
    });
    expect(result.markdown).toBeNull();
  });

  it("keeps a <br> as a hard break when the paragraph has formatting", () => {
    const result = htmlToMarkdown({
      html: chrome("<p><em>line one</em><br>line two</p>"),
      plain: "line one\nline two",
      types: HTML,
    });
    expect(result.markdown).toBe("_line one_\\\nline two");
  });

  it("writes nested lists, GFM tables and strikethrough", () => {
    const list = htmlToMarkdown({
      html: chrome("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"),
      plain: "a\nb\nc",
      types: HTML,
    });
    expect(list.markdown).toBe("- a\n  - b\n- c");

    const table = htmlToMarkdown({
      html: chrome(
        "<table><thead><tr><th>k</th><th>v</th></tr></thead><tbody><tr><td>a</td><td><del>b</del></td></tr></tbody></table>",
      ),
      plain: "k\tv\na\tb",
      types: HTML,
    });
    expect(table.markdown).toBe("| k | v     |\n| - | ----- |\n| a | ~~b~~ |");
  });

  it("keeps only absolute http(s) and mailto links", () => {
    const result = htmlToMarkdown({
      html: chrome(
        '<p><a href="/docs">relative</a> <a href="javascript:alert(1)">script</a> <a href="mailto:noreply@example.com">mail</a> <strong>x</strong></p><p>second</p>',
      ),
      plain: "relative script mail x\nsecond",
      types: HTML,
    });
    expect(result.markdown).toBe(
      "relative script [mail](mailto:noreply@example.com) **x**\n\nsecond",
    );
  });

  it("keeps only absolute http(s) images, falling back to the alt text", () => {
    const result = htmlToMarkdown({
      html: chrome(
        '<p><img src="data:image/png;base64,AAAA" alt="chart"> <img src="blob:https://example.com/1" alt=""> <img src="/logo.png" alt="logo"></p><p><img src="https://example.com/a.png" alt="kept"></p>',
      ),
      plain: "chart  logo\n\nkept",
      types: HTML,
    });
    expect(result.markdown).toBe(
      "chart  logo\n\n![kept](https://example.com/a.png)",
    );
  });

  it("keeps a fragment that has no block around it", () => {
    const result = htmlToMarkdown({
      html: '<img src="https://example.com/a.png"> and <b>bold</b>',
      plain: "",
      types: ["text/html"],
    });
    expect(result.markdown).toBe("![](https://example.com/a.png) and **bold**");
  });

  it("falls back to the HTML's text when the clipboard has no plain text", () => {
    const result = htmlToMarkdown({
      html: chrome("<h1>Only</h1>"),
      plain: "",
      types: ["text/html"],
    });
    expect(result).toEqual({ markdown: null, codeLike: false, inline: true });
  });
});
