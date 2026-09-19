import { CompletionContext } from "@codemirror/autocomplete";
import { defineLanguageFacet, Language } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM, parser } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import {
  tagCompletionSource,
  tagTriggerAt,
  templatesFor,
} from "../src/lib/editor/tag-completion.ts";

// Match MarkdownEditor's parser instead of mocking syntaxTree into prose.
const markdownLanguage = new Language(
  defineLanguageFacet(),
  parser.configure([GFM]),
);

function complete(marked: string) {
  const pos = marked.indexOf("¦");
  const state = EditorState.create({
    doc: marked.replace("¦", ""),
    extensions: [markdownLanguage],
  });
  return tagCompletionSource(new CompletionContext(state, pos, false));
}

describe("tagTriggerAt", () => {
  it.each([
    ["<", 0, ""],
    ["<d", 0, "d"],
    ["<details", 0, "details"],
    ["<DeT", 0, "DeT"],
    ["  <", 2, ""],
    ["   <", 3, ""],
    ["\t<", 1, ""],
    [" \t <DeTaIlS", 3, "DeTaIlS"],
  ])(
    "returns the exact replacement offset and query for %j",
    (before, at, query) => {
      expect(tagTriggerAt(before, "")).toEqual({ at, query });
    },
  );

  it.each(["", " ", "\t", " \t ", "\u00a0"])(
    "allows a whitespace-only suffix %j",
    (after) => {
      expect(tagTriggerAt("  <det", after)).toEqual({ at: 2, query: "det" });
    },
  );

  // v3: these fail if ^[ \t]* becomes .*, unlike the legal "  <" case.
  it.each(["x<", "a <", "- <", "> <", "| <"])(
    "rejects a non-indentation prefix in %j",
    (before) => {
      expect(tagTriggerAt(before, "")).toBeNull();
    },
  );

  it.each(["\u00a0<", "\v<", "\f<", "\n<"])(
    "rejects non-CommonMark indentation %j",
    (before) => {
      expect(tagTriggerAt(before, "")).toBeNull();
    },
  );

  it.each([
    "",
    "prose",
    "a < b",
    "<details>",
    "</details",
    "<<",
    "< details",
    "<det ",
    "<d1",
    "<d-",
    "<https://example.com",
  ])("rejects a completed tag or non-letter query in %j", (before) => {
    expect(tagTriggerAt(before, "")).toBeNull();
  });

  it.each(["tail", " tail", "\ttail", ">"])(
    "rejects existing content after the caret: %j",
    (after) => {
      expect(tagTriggerAt("<", after)).toBeNull();
    },
  );
});

describe("templatesFor", () => {
  it.each(["", "d", "det", "details", "DETaILS"])(
    "matches candidate names by a case-insensitive prefix: %j",
    (query) => {
      expect(templatesFor(query).map((template) => template.label)).toEqual([
        "<details>",
      ]);
    },
  );

  // Removing startsWith would fail these; substring or fuzzy matching also
  // fails the suffix/subsequence cases. Letter-only nonmatches are valid
  // triggers, but must not produce a candidate.
  it.each(["https", "H", "HARD", "summary", "etails", "dt", "detailsx"])(
    "offers no template for %j",
    (query) => {
      expect(tagTriggerAt(`<${query}`, "")).toEqual({ at: 0, query });
      expect(templatesFor(query)).toEqual([]);
    },
  );

  it("keeps the rich Markdown title, body, and final snippet field", () => {
    expect(templatesFor("")).toEqual([
      {
        label: "<details>",
        detail: "Collapsible block",
        template:
          "<details>\n<summary>\n\n${1:标题}\n\n</summary>\n\n${2:正文}\n\n</details>\n${0}",
      },
    ]);
  });
});

describe("tagCompletionSource with real Markdown syntax", () => {
  it.each([
    ["<¦", 0],
    ["<D¦", 0],
    ["<details¦", 0],
    ["<details>\n<¦", "<details>\n".length],
    ["<details>\n\n<det¦", "<details>\n\n".length],
    ["text\n\n  <DeT¦ \t", "text\n\n  ".length],
    ["- item\n  <¦", "- item\n  ".length],
    ["1. item\n   <¦", "1. item\n   ".length],
    ["- item\n\n  - nested\n\n    <¦", "- item\n\n  - nested\n\n    ".length],
  ])("offers a snippet at the exact document offset in %j", (marked, from) => {
    const result = complete(marked);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(from);
    expect(result?.filter).toBe(false);
    expect(result?.options).toEqual([
      {
        label: "<details>",
        detail: "Collapsible block",
        type: "tag",
        boost: 99,
        apply: expect.any(Function),
      },
    ]);
  });

  // These fixtures satisfy the textual trigger, so removing inLiteralContext
  // makes the source incorrectly offer a snippet. Both comment node kinds
  // matter: the paragraph prefix makes the last example an inline Comment.
  it.each([
    "```\n<¦\n```",
    "```\n<¦",
    "- item\n\n  ```\n  <¦\n  ```",
    "    <¦",
    "\t<¦",
    "text `code\n<¦\ncode`",
    "<!--\n<¦\n-->",
    "<!--\n<¦",
    "text <!--\n<¦\n-->",
  ])("suppresses code and comments in %j", (marked) => {
    const pos = marked.indexOf("¦");
    const before = marked.slice(0, pos).split("\n").at(-1) as string;
    expect(tagTriggerAt(before, "")).not.toBeNull();
    expect(complete(marked)).toBeNull();
  });

  it.each([
    "x<¦",
    "a <¦",
    "- <¦",
    "> <¦",
    "| <¦",
    "\u00a0<¦",
    "a < b¦",
    "<¦tail",
    "<¦ tail",
    "<det¦ails>",
    "<details>¦",
    "<https¦",
    "<https://example.com¦",
    "<H¦",
    "<HARD¦",
    "<summary¦",
  ])("offers no tag candidate in %j", (marked) => {
    expect(complete(marked)).toBeNull();
  });
});
