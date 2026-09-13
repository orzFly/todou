import type { IssueMetadataEntry } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  parseBulk,
  pickHeredocMark,
  serializeBulk,
} from "../src/lib/metadata-bulk.ts";
import { precheck } from "../src/lib/metadata-diff.ts";

let clock = 0;
/** A minimal entry with throwaway provenance; the syntax layer never reads it. */
const entry = (
  namespace: string,
  key: string,
  value: string,
): IssueMetadataEntry => ({
  namespace,
  key,
  value,
  updated_at: new Date(1_700_000_000_000 + clock++ * 1_000).toISOString(),
  updated_by: {
    id: 1,
    login: "ci-bridge",
    display_name: "ci-bridge",
    kind: "machine",
    avatar_url: null,
    owner: null,
  },
});

describe("parseBulk", () => {
  it("parses one plain line", () => {
    // Falsifies by: parser returning an empty map unconditionally.
    const result = parseBulk("ci/status = passing\n");
    expect(result).toEqual({
      ok: true,
      entries: new Map([["ci/status", "passing"]]),
    });
  });

  it("keeps `=` inside a value by splitting on the first one", () => {
    // Falsifies by: splitting with lastIndexOf("=").
    const result = parseBulk("ci/cmd = a=b");
    expect(result).toMatchObject({
      ok: true,
      entries: new Map([["ci/cmd", "a=b"]]),
    });
  });

  it("treats a mid-line `#` as value content and a leading one as a comment", () => {
    // Falsifies by: comment test using line.includes("#").
    const result = parseBulk("# note\nci/note = a # b");
    expect(result).toEqual({
      ok: true,
      entries: new Map([["ci/note", "a # b"]]),
    });
  });

  it("accepts any heredoc mark, not just EOF", () => {
    // Falsifies by: end-mark regex pinned to ^EOF$.
    for (const mark of ["EOF", "ANYMARK", "X-1"]) {
      const result = parseBulk(`ci/out = <<${mark}\nbody\n${mark}`);
      expect(result).toEqual({
        ok: true,
        entries: new Map([["ci/out", "body"]]),
      });
    }
  });

  it("keeps `#` lines inside a heredoc body verbatim", () => {
    // Falsifies by: comment stripping applied inside heredoc bodies.
    const result = parseBulk("ci/out = <<EOF\n# kept\nEOF");
    expect(result).toEqual({
      ok: true,
      entries: new Map([["ci/out", "# kept"]]),
    });
  });

  it("ends a heredoc only on a line that is exactly the mark", () => {
    // Falsifies by: comparing with line.trim() === mark.
    const result = parseBulk("ci/out = <<EOF\n  EOF\nEOF \nEOF");
    expect(result).toEqual({
      ok: true,
      entries: new Map([["ci/out", "  EOF\nEOF "]]),
    });
  });

  it("reports an unterminated heredoc at its opening line, naming the mark", () => {
    // Falsifies by: ending silently at end of file.
    const result = parseBulk("ci/x = 1\nci/out = <<WAITING\nbody");
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          line: 2,
          message: expect.stringContaining("WAITING"),
        },
      ],
    });
  });

  it("reports each invalid name on its own line", () => {
    // Falsifies by: skipping ns and key validation.
    const result = parseBulk("CI/x = 1\nci/X = 2\nci.x = 3");
    expect(result).toMatchObject({
      ok: false,
      errors: [
        { line: 1, message: expect.stringContaining("CI") },
        { line: 2, message: expect.stringContaining("X") },
        { line: 3, message: expect.stringContaining("/") },
      ],
    });
  });

  it("refuses a key set twice, citing both lines", () => {
    // Falsifies by: removing the duplicate check.
    const result = parseBulk("ci/x = 1\nci/y = 2\nci/x = 3");
    expect(result).toMatchObject({
      ok: false,
      errors: [{ line: 3, message: expect.stringContaining("line 1") }],
    });
  });
  it("reads an empty value as the empty string, not a deletion", () => {
    // Falsifies by: treating an empty value as absent.
    const result = parseBulk("ci/x =");
    expect(result).toEqual({ ok: true, entries: new Map([["ci/x", ""]]) });
  });
});

describe("serializeBulk / parseBulk round trip", () => {
  /**
   * B12: the one invariant the whole layer rests on. Both directions must
   * hold for the round trip to fail — fixing only the serializer cannot
   * resurrect a broken parser, which is what makes this test hard to fool.
   */
  const cases: Array<[string, string]> = [
    ["empty", ""],
    ["spaces", "   "],
    ["padded", "  padded  "],
    ["multiline", "one\ntwo\nthree"],
    ["with-EOF-line", "body\nEOF\nmore"],
    ["with-hash-line", "text\n# not a comment\nmore"],
    ["with-equals", "a=b=c"],
    ["leading-quote", '"quoted start'],
    ["cjk", "值有一行\n两行"],
    ["exact-limit", "x".repeat(4096)],
  ];

  for (const [name, value] of cases) {
    it(`round-trips ${name}`, () => {
      // Falsifies by: serializer not using a heredoc for `"`-leading values.
      const text = serializeBulk([entry("ci", "k", value)]);
      const result = parseBulk(text);
      expect(result).toEqual({
        ok: true,
        entries: new Map([["ci/k", value]]),
      });
    });
  }

  it("picks EOF2 when the value itself contains an EOF line", () => {
    // Falsifies by: pickHeredocMark always returning EOF.
    expect(pickHeredocMark("body\nEOF\nmore")).toBe("EOF2");
  });

  it("writes groups in server order with a blank line between namespaces", () => {
    const text = serializeBulk([
      entry("ci", "status", "passing"),
      entry("deploy", "host", "todou"),
    ]);
    expect(text).toBe("ci/status = passing\n\ndeploy/host = todou");
  });
});

describe("precheck", () => {
  it("measures the value limit in UTF-8 bytes, not characters", () => {
    // B10. Falsifies by: measuring with value.length — 1366 CJK characters
    // are 1366 long but 4098 bytes, one past the ceiling.
    const cjk = "鈴".repeat(1366);
    const errors = precheck(new Map([["ci/big", cjk]]));
    expect(errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("4098") }),
    ]);
  });

  it("reports the namespace and per-namespace key ceilings", () => {
    // B14. Falsifies by: removing the limits precheck.
    const nine: Array<[string, string]> = [];
    for (let ns = 1; ns <= 9; ns++) {
      nine.push([`ns${ns}/k`, "v"]);
    }
    expect(precheck(new Map(nine)).map((e) => e.message)).toEqual([
      expect.stringContaining("8 namespaces"),
    ]);

    const thirtyThree: Array<[string, string]> = [];
    for (let k = 1; k <= 33; k++) {
      thirtyThree.push([`ci/k${k}`, "v"]);
    }
    expect(precheck(new Map(thirtyThree)).map((e) => e.message)).toEqual([
      expect.stringContaining("ci] would carry 33"),
    ]);
  });
});

describe("heredoc mark choice", () => {
  it("stays with EOF for values without one", () => {
    expect(pickHeredocMark("plain value")).toBe("EOF");
  });
});
