import { MEMBER_ROLES } from "@todou/shared";
import { describe, expect, it } from "vitest";
import {
  normalizeHexColor,
  PRESET_COLORS,
  ROLES,
} from "../src/pages/project-settings.tsx";

describe("the member role picker", () => {
  it("offers every role, most privileged first", () => {
    expect(ROLES).toEqual(["admin", "writer", "reporter", "reader"]);
  });

  it("stays in step with the schema rather than keeping its own list", () => {
    expect(ROLES).toEqual([...MEMBER_ROLES]);
  });
});

describe("normalizeHexColor", () => {
  it("canonicalizes case and a missing hash", () => {
    expect(normalizeHexColor("#8B5CF6")).toBe("#8b5cf6");
    expect(normalizeHexColor("8b5cf6")).toBe("#8b5cf6");
    expect(normalizeHexColor("  #8b5cf6  ")).toBe("#8b5cf6");
  });

  it("expands 3-digit shorthand", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
    expect(normalizeHexColor("F00")).toBe("#ff0000");
  });

  it("rejects anything else", () => {
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor("#8b5c")).toBeNull();
    expect(normalizeHexColor("#8b5cf6ff")).toBeNull();
    expect(normalizeHexColor("rebeccapurple")).toBeNull();
  });
});

describe("PRESET_COLORS presets", () => {
  it("are already canonical so the server's ColorHex accepts them", () => {
    for (const color of PRESET_COLORS) {
      expect(normalizeHexColor(color)).toBe(color);
    }
  });

  it("have no duplicates", () => {
    expect(new Set(PRESET_COLORS).size).toBe(PRESET_COLORS.length);
  });
});
