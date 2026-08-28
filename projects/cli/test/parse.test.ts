import { describe, expect, it } from "vitest";
import { parseColor, parseIssueRef, splitCommaList } from "../src/parse.ts";

describe("parseIssueRef", () => {
  it("parses a bare number", () => {
    expect(parseIssueRef("16", "issue number")).toEqual({ number: 16 });
  });

  it("strips a leading hash", () => {
    expect(parseIssueRef("#16", "issue number")).toEqual({ number: 16 });
  });

  it("parses project/number", () => {
    expect(parseIssueRef("todou/16", "issue number")).toEqual({
      project: "todou",
      number: 16,
    });
  });

  it("accepts a hash after the slash", () => {
    expect(parseIssueRef("todou/#16", "issue number")).toEqual({
      project: "todou",
      number: 16,
    });
  });

  it("parses the prose form project#number", () => {
    expect(parseIssueRef("todou#16", "issue number")).toEqual({
      project: "todou",
      number: 16,
    });
  });

  it("keeps a bare hash from being read as a slug", () => {
    expect(parseIssueRef("#16", "issue number")).toEqual({ number: 16 });
  });

  it("treats an all-digit prefix as a project slug", () => {
    expect(parseIssueRef("42/16", "issue number")).toEqual({
      project: "42",
      number: 16,
    });
  });

  it.each(["a/b/16", "/16", "todou/", "/"])(
    'rejects the malformed shape "%s"',
    (value) => {
      expect(() => parseIssueRef(value, "issue number")).toThrow(
        /must be <number> or <project>\/<number>/,
      );
    },
  );

  it("rejects an invalid slug with a hint", () => {
    expect(() => parseIssueRef("TODOU/16", "issue number")).toThrow(
      /invalid project slug/,
    );
  });

  it("rejects a non-numeric number part", () => {
    expect(() => parseIssueRef("todou/abc", "issue number")).toThrow(
      /positive integer/,
    );
  });

  it("parses an issue URL, ignoring fragment and trailing slash", () => {
    expect(
      parseIssueRef(
        "https://todou.example/projects/todou/issues/16/#comment-3",
        "issue number",
      ),
    ).toEqual({
      project: "todou",
      number: 16,
      origin: "https://todou.example",
    });
  });

  it("rejects a URL that is not an issue URL", () => {
    expect(() =>
      parseIssueRef("https://todou.example/todou/16", "issue number"),
    ).toThrow(/not an issue URL/);
  });
});

describe("parseIssueRef prefixed forms (T-80)", () => {
  it("parses PREFIX-N and takes the number", () => {
    expect(parseIssueRef("T-76", "issue number")).toEqual({ number: 76 });
    expect(parseIssueRef("FOOBAR-8", "issue number")).toEqual({ number: 8 });
    expect(parseIssueRef("A_2X-9", "issue number")).toEqual({ number: 9 });
  });

  it("parses project/PREFIX-N", () => {
    expect(parseIssueRef("todou/T-76", "issue number")).toEqual({
      project: "todou",
      number: 76,
    });
  });

  it("rejects shapes that are not references", () => {
    // Lowercase or leading-digit prefixes are not the documented form.
    expect(() => parseIssueRef("t-76", "issue number")).toThrow(
      /positive integer/,
    );
    expect(() => parseIssueRef("2T-76", "issue number")).toThrow(
      /positive integer/,
    );
    expect(() => parseIssueRef("T-", "issue number")).toThrow(
      /positive integer/,
    );
    expect(() => parseIssueRef("T-1234567890", "issue number")).toThrow(
      /positive integer/,
    );
  });
});

describe("splitCommaList", () => {
  it("splits, trims, and drops the empties", () => {
    expect(splitCommaList(["area:cli, kind:bug", "needs-brainstorm"])).toEqual([
      "area:cli",
      "kind:bug",
      "needs-brainstorm",
    ]);
    expect(splitCommaList([" ", "a,,b,"])).toEqual(["a", "b"]);
    expect(splitCommaList([])).toEqual([]);
  });
});

describe("parseColor", () => {
  it("accepts every spelling anyone reaches for", () => {
    expect(parseColor("#3B82F6", "--color")).toBe("#3b82f6");
    expect(parseColor("3b82f6", "--color")).toBe("#3b82f6");
    expect(parseColor("#f00", "--color")).toBe("#ff0000");
    expect(parseColor("f00", "--color")).toBe("#ff0000");
  });

  it("names the accepted forms when it rejects one", () => {
    expect(() => parseColor("red", "--color")).toThrow(/must be a hex color/);
    expect(() => parseColor("#12345", "--color")).toThrow(/must be a hex/);
  });
});
