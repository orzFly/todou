import { describe, expect, it } from "vitest";
import { makePainter, relativeTime, table } from "../src/format.ts";

describe("table", () => {
  it("aligns columns and trims trailing padding", () => {
    expect(
      table([
        ["#1", "short", "open"],
        ["#20", "a longer title", "closed"],
      ]),
    ).toBe("#1   short           open\n#20  a longer title  closed");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-11T12:00:00Z");
  it.each([
    ["2026-08-11T11:59:30Z", "30s ago"],
    ["2026-08-11T11:15:00Z", "45m ago"],
    ["2026-08-11T03:00:00Z", "9h ago"],
    ["2026-08-01T12:00:00Z", "10d ago"],
    ["2026-05-11T12:00:00Z", "3mo ago"],
    ["2024-08-11T12:00:00Z", "2y ago"],
  ])("%s → %s", (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe("makePainter", () => {
  it("passes text through when the stream is not a TTY", () => {
    const paint = makePainter({}, {});
    expect(paint("red", "x")).toBe("x");
  });

  it("colors TTY streams unless NO_COLOR is set", () => {
    expect(makePainter({ isTTY: true }, {})("red", "x")).toContain("\x1b[");
    expect(makePainter({ isTTY: true }, { NO_COLOR: "1" })("red", "x")).toBe(
      "x",
    );
  });
});
