import { describe, expect, it } from "vitest";
import {
  blockquote,
  quotedReference,
  sourceLines,
} from "../src/lib/quote-markdown.ts";

describe("blockquote", () => {
  it("prefixes every line and keeps paragraphs in one block", () => {
    expect(blockquote("first\n\nsecond")).toBe("> first\n>\n> second");
  });

  it("nests a quote that was already quoted", () => {
    expect(blockquote("> said before")).toBe("> > said before");
  });

  it("writes a blank line as a bare marker, whitespace and all", () => {
    expect(blockquote("a\n   \nb")).toBe("> a\n>\n> b");
  });

  it("takes a fence whole, marker lines included", () => {
    expect(blockquote("```ts\nconst x = 1;\n```")).toBe(
      "> ```ts\n> const x = 1;\n> ```",
    );
  });

  it("drops the trailing blank lines rather than quoting them", () => {
    expect(blockquote("only line\n\n\n")).toBe("> only line");
  });

  it("gives an empty body a single marker", () => {
    expect(blockquote("")).toBe(">");
  });
});

describe("sourceLines", () => {
  const body = "one\ntwo\nthree\nfour";

  it("takes a closed interval", () => {
    expect(sourceLines(body, 2, 3)).toBe("two\nthree");
  });

  it("takes a single line when both ends agree", () => {
    expect(sourceLines(body, 4, 4)).toBe("four");
  });

  it("clamps both ends into the body", () => {
    expect(sourceLines(body, 0, 99)).toBe(body);
  });

  it("returns nothing when the range starts past the end", () => {
    expect(sourceLines(body, 10, 12)).toBe("");
  });
});

describe("quotedReference", () => {
  it("puts the quote, a blank line and the attribution in that order", () => {
    expect(
      quotedReference({
        body: "the finding\n\nand the number",
        authorLogin: "alice",
        permalink: "https://todou.example/projects/p/issues/370#comment-1234",
      }),
    ).toBe(
      [
        "> the finding",
        ">",
        "> and the number",
        "",
        "_Originally posted by @alice in https://todou.example/projects/p/issues/370#comment-1234_",
      ].join("\n"),
    );
  });
});
