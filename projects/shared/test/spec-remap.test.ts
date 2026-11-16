import { describe, expect, it } from "vitest";
import { remapLineRange } from "../src/spec-remap.ts";

describe("remapLineRange", () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps identical bodies as-is", () => {
    expect(remapLineRange(TEN, TEN, 2, 3)).toEqual({
      outdated: false,
      start: 2,
      end: 3,
    });
  });

  it("shifts ranges below an insertion", () => {
    const withHeader = `header a\nheader b\n${TEN}`;
    expect(remapLineRange(TEN, withHeader, 4, 5)).toEqual({
      outdated: false,
      start: 6,
      end: 7,
    });
  });

  it("keeps ranges above a change untouched", () => {
    const tailEdit = TEN.replace("line 9", "line nine");
    expect(remapLineRange(TEN, tailEdit, 2, 3)).toEqual({
      outdated: false,
      start: 2,
      end: 3,
    });
  });

  it("outdates ranges overlapping an edit", () => {
    const midEdit = TEN.replace("line 3", "line three");
    expect(remapLineRange(TEN, midEdit, 2, 4).outdated).toBe(true);
  });

  it("outdates ranges split by an insertion inside them", () => {
    const lines = TEN.split("\n");
    lines.splice(2, 0, "inserted");
    expect(remapLineRange(TEN, lines.join("\n"), 2, 4).outdated).toBe(true);
  });

  it("outdates ranges whose lines were deleted", () => {
    const lines = TEN.split("\n");
    lines.splice(1, 2);
    expect(remapLineRange(TEN, lines.join("\n"), 2, 3).outdated).toBe(true);
  });
});
