import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  type CapabilityId,
  can,
  capabilityOf,
  minRoleOf,
  ROLE_RANK,
  roleRankOf,
} from "../src/permissions.ts";
import { MEMBER_ROLES, type MemberRole } from "../src/schemas/project.ts";

describe("ROLE_RANK", () => {
  it("covers every value of the MemberRole enum", () => {
    expect(Object.keys(ROLE_RANK).sort()).toEqual([...MEMBER_ROLES].sort());
  });

  it("is strictly increasing along the enum read backwards", () => {
    // `MEMBER_ROLES` is descending authority, so reversing it must
    // produce ascending ranks with no ties — a tie would make two roles
    // silently interchangeable at every gate.
    const ascending = [...MEMBER_ROLES].reverse();
    const ranks = ascending.map((role) => ROLE_RANK[role]);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
    }
  });

  it("places reporter between reader and writer", () => {
    expect(ROLE_RANK.reader).toBeLessThan(ROLE_RANK.reporter);
    expect(ROLE_RANK.reporter).toBeLessThan(ROLE_RANK.writer);
  });

  it("does not assign future or inherited names a comparable rank", () => {
    for (const role of [
      "future-role",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      expect(roleRankOf(role)).toBeUndefined();
    }
    for (const role of MEMBER_ROLES) {
      expect(roleRankOf(role)).toBe(ROLE_RANK[role]);
    }
  });

  it("does not hide missing required role data as an unknown role", () => {
    for (const role of [undefined, null, "", 0]) {
      expect(() => roleRankOf(role as string)).toThrow(TypeError);
    }
  });
});

describe("CAPABILITIES", () => {
  it("has no duplicate ids", () => {
    const ids = CAPABILITIES.map((cap) => cap.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names a real role in every minRole", () => {
    for (const cap of CAPABILITIES) {
      expect(MEMBER_ROLES).toContain(cap.minRole);
    }
  });
});

describe("spec.withdraw", () => {
  it("is a writer gate independent of ownership", () => {
    expect(capabilityOf("spec.withdraw")).toEqual({
      id: "spec.withdraw",
      minRole: "writer",
      enforce: "gate",
    });
    expect(can(null, "spec.withdraw")).toBe(false);
    expect(can("reader", "spec.withdraw")).toBe(false);
    expect(can("reporter", "spec.withdraw")).toBe(false);
    expect(can("writer", "spec.withdraw")).toBe(true);
    expect(can("admin", "spec.withdraw")).toBe(true);
  });
});

describe("can", () => {
  it("refuses an unknown existing role every capability", () => {
    for (const role of [
      "future-role",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      for (const cap of CAPABILITIES) {
        expect(can(role, cap.id)).toBe(false);
      }
    }
  });

  it("does not hide a missing required role or capability", () => {
    expect(() => can(undefined as unknown as string, "project.read")).toThrow(
      TypeError,
    );
    expect(() =>
      can("future-role", undefined as unknown as CapabilityId),
    ).toThrow(TypeError);
  });

  it("rejects an invalid local minimum instead of making it the lowest role", () => {
    const capability = capabilityOf("project.read");
    const original = capability.minRole;
    try {
      for (const invalid of ["future-role", "constructor", undefined]) {
        capability.minRole = invalid as MemberRole;
        expect(() => minRoleOf(capability.id as CapabilityId)).toThrow(
          TypeError,
        );
        for (const role of ["reader", "admin", "future-role"]) {
          expect(() => can(role, "project.read")).toThrow(TypeError);
        }
      }
    } finally {
      capability.minRole = original;
    }
  });

  it("refuses a non-member everything", () => {
    for (const cap of CAPABILITIES) {
      expect(can(null, cap.id)).toBe(false);
    }
  });

  it("grants an admin everything", () => {
    for (const cap of CAPABILITIES) {
      expect(can("admin", cap.id)).toBe(true);
    }
  });

  it("keeps a reader out of opening issues and commenting", () => {
    expect(can("reader", "issue.create")).toBe(false);
    expect(can("reader", "comment.create")).toBe(false);
  });

  it("lets a reporter report and maintain what it posted", () => {
    expect(can("reporter", "issue.create")).toBe(true);
    expect(can("reporter", "comment.create")).toBe(true);
    expect(can("reporter", "comment.modify")).toBe(true);
    expect(can("reporter", "issue.update")).toBe(true);
    expect(can("reporter", "issue.trash")).toBe(true);
    expect(can("reporter", "attachment.upload")).toBe(true);
  });

  it("keeps triage, specs and moves above the reporter", () => {
    expect(can("reporter", "issue.triage")).toBe(false);
    expect(can("reporter", "issue.move")).toBe(false);
    expect(can("reporter", "issue.move_in")).toBe(false);
    expect(can("reporter", "comment.commands")).toBe(false);
    expect(can("reporter", "question.answer")).toBe(false);
    expect(can("reporter", "spec.push")).toBe(false);
    expect(can("reporter", "label.create")).toBe(false);
  });

  it("gives a writer the label catalog but not the project", () => {
    expect(can("writer", "label.create")).toBe(true);
    expect(can("writer", "label.update")).toBe(true);
    expect(can("writer", "label.delete")).toBe(true);

    expect(can("writer", "project.update")).toBe(false);
    expect(can("writer", "member.set")).toBe(false);
    expect(can("writer", "status.manage")).toBe(false);
  });

  it("agrees with minRoleOf at the boundary of every capability", () => {
    for (const cap of CAPABILITIES) {
      const id: CapabilityId = cap.id;
      const min = minRoleOf(id);
      expect(can(min, id)).toBe(true);
      for (const role of MEMBER_ROLES) {
        expect(can(role, id)).toBe(ROLE_RANK[role] >= ROLE_RANK[min]);
      }
    }
  });
});
