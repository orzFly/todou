import { describe, expect, it } from "vitest";
import {
  classifyRefEvent,
  type MoveContext,
  type RefEvent,
} from "../src/services/move/normalize.ts";

const A = 3;
const B = 7;
const AT = new Date("2026-02-01T00:00:00.000Z");

const ctx = (over: Partial<MoveContext> = {}): MoveContext => ({
  landed: B,
  landedNumber: 45,
  slugOf: (id) => (id === A ? "a" : id === B ? "b" : null),
  resolveSlug: (slug) => (slug === "a" ? A : slug === "b" ? B : null),
  commentAlias: () => null,
  ...over,
});

const event = (over: Partial<RefEvent>): RefEvent => ({
  type: "referenced",
  payload: {},
  createdAt: AT,
  host: A,
  ...over,
});

/**
 * The four rows of the normalization table, plus the two properties the
 * design leans on: it is idempotent, and it keys off project ids rather than
 * slugs wherever it can.
 */
describe("classifyRefEvent", () => {
  it("turns a same-project reference on the card into a cross-project one", () => {
    const result = classifyRefEvent(
      event({ type: "referenced", payload: { by_issue: 12 } }),
      "on-the-card",
      ctx(),
    );
    expect(result).toEqual({
      type: "cross_referenced",
      payload: {
        by_issue: 12,
        by_project_id: A,
        by_project: "a",
        by_moved: true,
      },
    });
  });

  it("turns a reference from the destination into a local one", () => {
    const result = classifyRefEvent(
      event({
        type: "cross_referenced",
        payload: { by_project: "b", by_project_id: B, by_issue: 1 },
      }),
      "on-the-card",
      ctx(),
    );
    expect(result).toEqual({ type: "referenced", payload: { by_issue: 1 } });
  });

  it("renumbers an event on another card in the source project", () => {
    const result = classifyRefEvent(
      event({
        type: "referenced",
        payload: { by_issue: 123, by_comment: 1462 },
        host: A,
      }),
      "about-the-card",
      ctx({ commentAlias: (id) => (id === 1462 ? 2001 : null) }),
    );
    expect(result).toEqual({
      type: "cross_referenced",
      payload: {
        by_issue: 45,
        by_comment: 2001,
        by_project_id: B,
        by_project: "b",
        by_moved: true,
      },
    });
  });

  it("localizes an event on another card in the destination project", () => {
    const result = classifyRefEvent(
      event({
        type: "cross_referenced",
        payload: { by_project: "a", by_issue: 123, by_comment: 1462 },
        host: B,
      }),
      "about-the-card",
      ctx({ commentAlias: (id) => (id === 1462 ? 2001 : null) }),
    );
    expect(result).toEqual({
      type: "referenced",
      payload: { by_issue: 45, by_comment: 2001 },
    });
  });

  it("reads a slug-only event as of its own timestamp", () => {
    // The slug changed hands after the event: resolving it as of "now" would
    // attribute the reference to whoever holds "a" today.
    const resolveSlug = (slug: string, at: Date) =>
      slug === "a" ? (at < AT ? A : 999) : null;
    const result = classifyRefEvent(
      event({
        type: "cross_referenced",
        payload: { by_project: "a", by_issue: 5 },
        createdAt: new Date(AT.getTime() - 1000),
      }),
      "on-the-card",
      ctx({ resolveSlug }),
    );
    expect(result?.payload.by_project_id).toBe(A);
  });

  it("is idempotent — a second pass reports nothing to change", () => {
    const first = classifyRefEvent(
      event({ type: "referenced", payload: { by_issue: 12 } }),
      "on-the-card",
      ctx(),
    );
    expect(first).not.toBeNull();
    const again = classifyRefEvent(
      event({
        type: first?.type as string,
        payload: first?.payload as Record<string, unknown>,
      }),
      "on-the-card",
      ctx(),
    );
    expect(again).toBeNull();
  });

  it("comes back to its original shape on the return trip", () => {
    const original = event({ type: "referenced", payload: { by_issue: 12 } });
    const away = classifyRefEvent(original, "on-the-card", ctx());
    const back = classifyRefEvent(
      event({
        type: away?.type as string,
        payload: away?.payload as Record<string, unknown>,
      }),
      "on-the-card",
      // The card moved back into A.
      ctx({ landed: A, landedNumber: 123 }),
    );
    expect(back).toEqual({ type: "referenced", payload: { by_issue: 12 } });
  });

  it("leaves events that are not references alone", () => {
    expect(
      classifyRefEvent(
        event({ type: "closed", payload: {} }),
        "on-the-card",
        ctx(),
      ),
    ).toBeNull();
  });

  it("gives up rather than guess when a slug resolves to nobody", () => {
    expect(
      classifyRefEvent(
        event({
          type: "cross_referenced",
          payload: { by_project: "gone", by_issue: 5 },
        }),
        "on-the-card",
        ctx(),
      ),
    ).toBeNull();
  });
});
