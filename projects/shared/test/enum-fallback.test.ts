import { describe, expect, it, vi } from "vitest";
import { enumLookup, enumValue } from "../src/enum-fallback.ts";

describe("forward-compatible enum lookup", () => {
  it("preserves known values and only degrades unknown strings", () => {
    const fallback = vi.fn((value: string) => `unknown: ${value}`);
    const map = { approved: "Approved", quiet: "" };
    expect(enumLookup(map, "approved", fallback)).toBe("Approved");
    expect(enumLookup(map, "quiet", fallback)).toBe("");
    expect(fallback).not.toHaveBeenCalled();
    for (const value of [
      "future_state",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(enumLookup(map, value, fallback)).toBe(`unknown: ${value}`);
    }
  });

  it("preserves the field name when a required mapped value is missing", () => {
    const missing = undefined as unknown as string;
    expect(() =>
      enumLookup({ approved: "Approved" }, missing, () => "Unknown", "review_status"),
    ).toThrow("review_status must be a non-empty string");
  });

  it.each([undefined, null, "", 42, {}, []])(
    "rejects malformed required values: %j",
    (invalid) => {
      // Deliberately model an unvalidated wire response without changing schemas.
      const value = invalid as string;
      const fallback = vi.fn(() => "Unknown");
      expect(() => enumValue(value)).toThrow(TypeError);
      expect(() =>
        enumLookup({ approved: "Approved" }, value, fallback),
      ).toThrow(TypeError);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it("does not disguise a missing known mapping as a future enum value", () => {
    const fallback = vi.fn(() => "Unknown");
    expect(() =>
      enumLookup({ approved: undefined }, "approved", fallback),
    ).toThrow(TypeError);
    expect(fallback).not.toHaveBeenCalled();
  });
});
