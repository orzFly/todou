import { describe, expect, it } from "vitest";
import { isMinor } from "../src/watch-tiers.ts";

const event = (event_type: string, payload: Record<string, unknown> = {}) => ({
  type: "event" as const,
  event_type,
  payload,
});

describe("isMinor (T-694)", () => {
  it.each([
    "referenced",
    "cross_referenced",
    "attachment_added",
    "attachment_deleted",
    "spec_comments_resolved",
  ])("holds %s", (type) => {
    expect(isMinor(event(type))).toBe(true);
  });

  it.each(["block_added", "block_removed"])(
    "holds %s only on the blocker's end",
    (type) => {
      expect(isMinor(event(type, { role: "blocker" }))).toBe(true);
      // The blocked end may be learning it can start, or must stop.
      expect(isMinor(event(type, { role: "blocked" }))).toBe(false);
      expect(isMinor(event(type))).toBe(false);
      expect(isMinor(event(type, { role: "something-new" }))).toBe(false);
    },
  );

  it.each([
    "status_changed",
    "label_added",
    "title_changed",
    "spec_review",
    "block_cleared",
    // An event type this client has never heard of starts out urgent.
    "invented_later",
  ])("delivers %s at once", (type) => {
    expect(isMinor(event(type))).toBe(false);
  });

  it("never holds a comment", () => {
    expect(isMinor({ type: "comment" })).toBe(false);
  });
});
