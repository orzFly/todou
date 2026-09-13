import type { IssueMetadataEntry } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { parseJsonDoc, serializeJsonDoc } from "../src/lib/metadata-json.ts";

let clock = 0;
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

describe("parseJsonDoc", () => {
  it("parses one namespaced key", () => {
    // J1. Falsifies by: parser returning an empty map unconditionally.
    const result = parseJsonDoc('{"ci": {"status": "passing"}}');
    expect(result).toEqual({
      ok: true,
      entries: new Map([["ci/status", "passing"]]),
    });
  });

  it("reports a non-string member", () => {
    // J3. Falsifies by: skipping member type checks.
    const result = parseJsonDoc('{"ci": {"n": 1}}');
    expect(result).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("ci/n") }],
    });
  });

  it("reports a non-object root and a non-object namespace", () => {
    // J4. Falsifies by: skipping shape validation.
    expect(parseJsonDoc("[1, 2]")).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("object") }],
    });
    expect(parseJsonDoc('{"ci": "text"}')).toMatchObject({
      ok: false,
      errors: [{ message: expect.stringContaining("ci") }],
    });
  });

  it("reports invalid JSON with a line number", () => {
    const result = parseJsonDoc('{"ci": {\n  "broken": }');
    expect(result).toMatchObject({
      ok: false,
      errors: [{ line: expect.any(Number), message: expect.any(String) }],
    });
  });
});

describe("serializeJsonDoc", () => {
  it("writes two-space indented JSON in input order", () => {
    // J2. Falsifies by: serializing with plain JSON.stringify (no indent).
    const text = serializeJsonDoc([
      entry("ci", "status", "passing"),
      entry("ci", "note", "first"),
    ]);
    expect(text).toBe(
      '{\n  "ci": {\n    "status": "passing",\n    "note": "first"\n  }\n}\n',
    );
  });
});

describe("JSON round trip", () => {
  /**
   * J5: the same boundary table the Bulk layer round-trips, through the JSON
   * encoding instead. Falsifies by: serializing without escaping newlines —
   * every multi-line case then fails to parse.
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
      const text = serializeJsonDoc([entry("ci", "k", value)]);
      expect(parseJsonDoc(text)).toEqual({
        ok: true,
        entries: new Map([["ci/k", value]]),
      });
    });
  }
});
