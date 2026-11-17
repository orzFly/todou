import { describe, expect, it } from "vitest";
import { sideBySidePanes } from "@/lib/image-zoom.ts";

describe("sideBySidePanes", () => {
  it("stacks a wide screenshot, which fits larger one above the other", () => {
    const { direction, panes } = sideBySidePanes(
      992,
      600,
      { width: 720, height: 400 },
      false,
    );
    expect(direction).toBe("column");
    expect(panes).toEqual([
      { x: 0, y: 0, width: 992, height: 296 },
      { x: 0, y: 304, width: 992, height: 296 },
    ]);
  });

  it("puts a tall picture beside its twin", () => {
    const { direction, panes } = sideBySidePanes(
      992,
      600,
      { width: 400, height: 900 },
      false,
    );
    expect(direction).toBe("row");
    expect(panes).toEqual([
      { x: 0, y: 0, width: 492, height: 600 },
      { x: 500, y: 0, width: 492, height: 600 },
    ]);
  });

  it("keeps a tie side by side", () => {
    // Both arrangements fit 200×200 at 0.5.
    expect(
      sideBySidePanes(208, 208, { width: 200, height: 200 }, false).direction,
    ).toBe("row");
  });

  it("chooses by the enlarged fit when maximized", () => {
    const icon = { width: 72, height: 40 };
    // Never enlarged, both arrangements draw it at 100%: a tie.
    expect(sideBySidePanes(992, 600, icon, false).direction).toBe("row");
    // Enlarged, stacking draws it at 7.4× against 6.8× side by side.
    expect(sideBySidePanes(992, 600, icon, true).direction).toBe("column");
  });

  it("honours a different gap", () => {
    const { panes } = sideBySidePanes(
      1000,
      600,
      { width: 400, height: 900 },
      false,
      20,
    );
    expect(panes[1]).toEqual({ x: 510, y: 0, width: 490, height: 600 });
  });
});
