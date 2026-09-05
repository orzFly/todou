import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  type CapabilityId,
  can,
  minRoleOf,
  ROLE_RANK,
} from "../src/permissions.ts";
import { MEMBER_ROLES } from "../src/schemas/project.ts";

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

describe("can", () => {
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
