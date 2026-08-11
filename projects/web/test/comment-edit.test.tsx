import { describe, expect, it } from "vitest";
import { canEditComment } from "../src/components/timeline/comment-item.tsx";

describe("canEditComment", () => {
  it("allows the author", () => {
    expect(canEditComment({ id: 2, isAdmin: false }, 2)).toBe(true);
  });

  it("allows project admins on any comment", () => {
    expect(canEditComment({ id: 1, isAdmin: true }, 2)).toBe(true);
  });

  it("denies other members and anonymous viewers", () => {
    expect(canEditComment({ id: 3, isAdmin: false }, 2)).toBe(false);
    expect(canEditComment(null, 2)).toBe(false);
    expect(canEditComment(undefined, 2)).toBe(false);
  });
});
