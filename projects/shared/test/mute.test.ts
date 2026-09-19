import { describe, expect, it } from "vitest";
import { MutedProject, MuteList } from "../src/schemas/mute.ts";

const project = {
  slug: "muted-icon-contract",
  name: "Muted icon contract",
  muted_at: "2026-01-02T00:00:00.000Z",
};

describe("muted project icon contract", () => {
  it.each([null, "/api/projects/1/icon?v=12345678"])(
    "preserves icon_url %s through MutedProject and MuteList",
    (icon_url) => {
      const withIcon = { ...project, icon_url };
      expect(MutedProject.parse(withIcon)).toEqual(withIcon);
      expect(MuteList.parse({ issues: [], projects: [withIcon] })).toEqual({
        issues: [],
        projects: [withIcon],
      });
    },
  );

  it("requires icon_url even when there is no icon", () => {
    expect(MutedProject.safeParse(project).success).toBe(false);
    expect(
      MutedProject.safeParse({ ...project, icon_url: undefined }).success,
    ).toBe(false);
    expect(
      MuteList.safeParse({ issues: [], projects: [project] }).success,
    ).toBe(false);
  });

  it("rejects a non-string, non-null icon_url", () => {
    expect(MutedProject.safeParse({ ...project, icon_url: 123 }).success).toBe(
      false,
    );
  });
});
