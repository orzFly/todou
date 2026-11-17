import { describe, expect, it } from "vitest";
import { findMermaidFences } from "../src/mermaid/fences.ts";

describe("findMermaidFences", () => {
  it("finds a backtick fence and the line its content starts on", () => {
    const text = "intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\nafter";
    expect(findMermaidFences(text)).toEqual([
      { startLine: 4, source: "flowchart LR\n  A --> B" },
    ]);
  });

  it("finds a tilde fence", () => {
    expect(findMermaidFences("~~~mermaid\npie\n~~~")).toEqual([
      { startLine: 2, source: "pie" },
    ]);
  });

  it("does not close on a shorter fence, and does on a longer one", () => {
    const text = "````mermaid\nA\n```\nB\n`````\nafter";
    expect(findMermaidFences(text)).toEqual([
      { startLine: 2, source: "A\n```\nB" },
    ]);
  });

  it("does not close on the other fence character", () => {
    expect(findMermaidFences("```mermaid\nA\n~~~\nB\n```")).toEqual([
      { startLine: 2, source: "A\n~~~\nB" },
    ]);
  });

  it("takes a fence inside a list item, minus the fence's indent", () => {
    const text = "- item\n\n  ```mermaid\n  flowchart LR\n    A --> B\n  ```";
    expect(findMermaidFences(text)).toEqual([
      { startLine: 4, source: "flowchart LR\n  A --> B" },
    ]);
  });

  it("takes a fence opened on the list marker's own line", () => {
    expect(findMermaidFences("1. ```mermaid\n   pie\n   ```")).toEqual([
      { startLine: 2, source: "pie" },
    ]);
  });

  it("reads the first word of the info string", () => {
    expect(
      findMermaidFences('``` mermaid title="x"\npie\n```\n```mermaidx\nA\n```'),
    ).toEqual([{ startLine: 2, source: "pie" }]);
  });

  it("matches the tag case-sensitively, as the web does", () => {
    expect(findMermaidFences("```Mermaid\npie\n```")).toEqual([]);
  });

  it("runs an unclosed fence to the end of the document", () => {
    expect(findMermaidFences('text\n```mermaid\npie\n  "a" : 1')).toEqual([
      { startLine: 3, source: 'pie\n  "a" : 1' },
    ]);
  });

  it("skips other fences, and a mermaid fence shown inside one", () => {
    const text =
      "````markdown\n```mermaid\nnot real\n```\n````\n```ts\nx\n```\n```mermaid\npie\n```";
    expect(findMermaidFences(text)).toEqual([{ startLine: 10, source: "pie" }]);
  });

  it("does not look inside a blockquote", () => {
    expect(findMermaidFences("> ```mermaid\n> pie\n> ```")).toEqual([]);
  });

  it("does not take inline code for a fence", () => {
    expect(findMermaidFences("```mermaid` inline\npie")).toEqual([]);
  });

  it("counts CRLF line endings as one line each", () => {
    expect(findMermaidFences("a\r\n```mermaid\r\npie\r\n```")).toEqual([
      { startLine: 3, source: "pie" },
    ]);
  });
});
