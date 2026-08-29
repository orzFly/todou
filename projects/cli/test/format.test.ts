import { describe, expect, it } from "vitest";
import {
  formatBytes,
  makePainter,
  relativeTime,
  summarize,
  table,
} from "../src/format.ts";

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

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [20 * 1024 * 1024, "20.0 MB"],
    [3 * 1024 ** 3 + 512 * 1024 ** 2, "3.5 GB"],
  ])("%i → %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("steps up rather than printing a unit's own ceiling", () => {
    expect(formatBytes(1024 ** 2 - 1)).toBe("1.0 MB");
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

describe("summarize", () => {
  it("folds newlines and runs of whitespace into single spaces", () => {
    expect(summarize("first line\n\n  second\tline  ", 40)).toBe(
      "first line second line",
    );
  });

  it("leaves a body that exactly fits without an ellipsis", () => {
    expect(summarize("12345", 5)).toBe("12345");
    expect(summarize("123456", 5)).toBe("12345…");
  });

  it("counts CJK by character, not by byte", () => {
    expect(summarize("要在 dogfood 上开先把 CLI 发布到镜像里", 8)).toBe(
      "要在 dogfo…",
    );
  });

  it("never splits a surrogate pair at the cut", () => {
    const cut = summarize("🐱🐱🐱", 2);
    expect(cut).toBe("🐱🐱…");
    expect(cut).not.toContain("�");
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
