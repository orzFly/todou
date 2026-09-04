import { describe, expect, it } from "vitest";
import { ownerAt } from "../src/ownership.ts";
import type { IssueMove } from "../src/schemas/issue.ts";

const A = 3;
const B = 7;

const move = (at: string, fromId: number | null): IssueMove => ({
  at,
  from_project_id: fromId,
  from_project: fromId === null ? null : `p${fromId}`,
  from_number: fromId === null ? null : 123,
});

describe("ownerAt", () => {
  it("answers the current project for a card that never moved", () => {
    expect(ownerAt([], B, "2026-01-01T00:00:00.000000Z")).toBe(B);
  });

  it("splits at a single move", () => {
    const moves = [move("2026-02-01T00:00:00.000000Z", A)];
    expect(ownerAt(moves, B, "2026-01-15T00:00:00.000000Z")).toBe(A);
    expect(ownerAt(moves, B, "2026-03-01T00:00:00.000000Z")).toBe(B);
  });

  it("walks a round trip A → B → A", () => {
    const moves = [
      move("2026-02-01T00:00:00.000000Z", A),
      move("2026-03-01T00:00:00.000000Z", B),
    ];
    expect(ownerAt(moves, A, "2026-01-15T00:00:00.000000Z")).toBe(A);
    expect(ownerAt(moves, A, "2026-02-15T00:00:00.000000Z")).toBe(B);
    expect(ownerAt(moves, A, "2026-03-15T00:00:00.000000Z")).toBe(A);
  });

  it("orders by `at`, not by array position", () => {
    const moves = [
      move("2026-03-01T00:00:00.000000Z", B),
      move("2026-02-01T00:00:00.000000Z", A),
    ];
    expect(ownerAt(moves, A, "2026-02-15T00:00:00.000000Z")).toBe(B);
  });

  it("reports an unknown owner for a redacted interval", () => {
    const moves = [move("2026-02-01T00:00:00.000000Z", null)];
    expect(ownerAt(moves, B, "2026-01-15T00:00:00.000000Z")).toBeNull();
    expect(ownerAt(moves, B, "2026-03-01T00:00:00.000000Z")).toBe(B);
  });

  it("gives the move's own instant to the destination", () => {
    const at = "2026-02-01T00:00:00.000000Z";
    expect(ownerAt([move(at, A)], B, at)).toBe(B);
  });
});
