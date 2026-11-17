import { describe, expect, it } from "vitest";
import {
  arrangementOf,
  drawLine,
  type Item,
  LINE_ID,
  lineStatusOf,
  move,
  orderRequest,
  roleException,
} from "../src/lib/status-arrangement.ts";

// Backlog 1, Todo 2, Shipped 3, Done 4, Invalid 5.
const STATUSES = [
  { id: 1, category: "open" as const },
  { id: 2, category: "open" as const },
  { id: 3, category: "open" as const },
  { id: 4, category: "closed" as const },
  { id: 5, category: "closed" as const },
];

const show = (items: Item[]) =>
  items.map((item) => (item.kind === "line" ? "|" : String(item.id))).join("");

describe("status arrangement (T-712)", () => {
  it("puts the line directly above the status it names", () => {
    expect(show(arrangementOf(STATUSES, 3))).toBe("12|345");
    expect(show(arrangementOf(STATUSES, 1))).toBe("|12345");
    expect(show(arrangementOf(STATUSES, null))).toBe("12345");
  });

  it("moves a status and turns the arrangement into one request", () => {
    const items = move(arrangementOf(STATUSES, 3), 1, 2);
    expect(show(items)).toBe("21|345");
    expect(orderRequest(items)).toEqual({
      ids: [2, 1, 3, 4, 5],
      block_clear_status_id: 3,
    });
  });

  it("moves the line on its own", () => {
    const items = move(arrangementOf(STATUSES, 3), LINE_ID, 3);
    expect(show(items)).toBe("123|45");
    expect(orderRequest(items)).toEqual({
      ids: [1, 2, 3, 4, 5],
      block_clear_status_id: 4,
    });
  });

  it("dragging the line's own status above it moves both", () => {
    const items = move(arrangementOf(STATUSES, 3), 3, LINE_ID);
    expect(show(items)).toBe("123|45");
    expect(orderRequest(items)).toEqual({
      ids: [1, 2, 3, 4, 5],
      block_clear_status_id: 4,
    });

    const past = move(arrangementOf(STATUSES, 3), 3, 4);
    expect(show(past)).toBe("12|435");
    expect(orderRequest(past)).toEqual({
      ids: [1, 2, 4, 3, 5],
      block_clear_status_id: 4,
    });
  });

  it("never leaves the line last", () => {
    const items = move(arrangementOf(STATUSES, 3), LINE_ID, 5);
    expect(show(items)).toBe("1234|5");
    expect(lineStatusOf(items)).toBe(5);

    // Taking the last status above the line would leave it last too.
    const last = move(arrangementOf(STATUSES, 5), 5, LINE_ID);
    expect(show(last)).toBe("1234|5");
  });

  it("removes the line and draws it again", () => {
    const none = arrangementOf(STATUSES, null);
    expect(orderRequest(none).block_clear_status_id).toBeNull();
    expect(show(drawLine(none, STATUSES))).toBe("123|45");
    // With no closed status, above the last one.
    const open = STATUSES.map((s) => ({ ...s, category: "open" as const }));
    expect(show(drawLine(arrangementOf(open, null), open))).toBe("1234|5");
  });

  it("names a role only when it departs from the category's", () => {
    expect(roleException({ category: "open" }, "remaining")).toBeNull();
    expect(roleException({ category: "closed" }, "completed")).toBeNull();
    expect(roleException({ category: "open" }, "completed")).toBe("completed");
    expect(roleException({ category: "closed" }, "excluded")).toBe("excluded");
    expect(roleException({ category: "closed" }, "remaining")).toBe(
      "remaining",
    );
  });
});
