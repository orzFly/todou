import { describe, expect, it } from "vitest";
import { type ByteRange, byteRangeOf } from "../src/http/byte-range.ts";

const whole: ByteRange = { kind: "whole" };
const unsatisfiable: ByteRange = { kind: "unsatisfiable" };
const part = (start: number, end: number): ByteRange => ({
  kind: "part",
  start,
  end,
});

describe("byteRangeOf (T-806)", () => {
  it.each<[string | undefined, ByteRange]>([
    [undefined, whole],
    ["bytes=0-9", part(0, 9)],
    ["bytes=0-0", part(0, 0)],
    ["bytes=590-", part(590, 596)],
    ["bytes=590-9999", part(590, 596)],
    ["bytes=-7", part(590, 596)],
    ["bytes=-9999", part(0, 596)],
    ["BYTES=0-1", part(0, 1)],
    ["bytes= 0-1 ", part(0, 1)],
    ["bytes=597-", unsatisfiable],
    ["bytes=99999999999999999999-", unsatisfiable],
    ["bytes=-0", unsatisfiable],
    ["bytes=0-1,5-6", whole],
    ["bytes=5-2", whole],
    ["bytes=a-b", whole],
    ["bytes=", whole],
    ["bytes=-", whole],
    ["bytes=0-1,", whole],
    ["items=0-1", whole],
    ["bytes0-1", whole],
  ])("%s against 597 bytes", (header, expected) => {
    expect(byteRangeOf(header, 597)).toEqual(expected);
  });

  it("serves an empty file whole, whatever the range", () => {
    expect(byteRangeOf("bytes=0-9", 0)).toEqual(whole);
  });
});
