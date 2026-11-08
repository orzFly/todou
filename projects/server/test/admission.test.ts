import { describe, expect, it } from "vitest";
import { admissionRefusal } from "../src/auth/admission.ts";

const open = {
  requireEmailVerified: false,
  allowedEmailDomains: [],
  allowedGroups: [],
};

describe("admissionRefusal", () => {
  it("admits anything when nothing is configured", () => {
    expect(admissionRefusal(open, { email: null, groups: null })).toBeNull();
  });

  it("takes email_verified as a boolean or the string some IdPs send", () => {
    const policy = { ...open, requireEmailVerified: true };
    for (const emailVerified of [true, "true"]) {
      expect(
        admissionRefusal(policy, { email: null, emailVerified, groups: null }),
      ).toBeNull();
    }
    for (const emailVerified of [false, "false", 1, undefined]) {
      expect(
        admissionRefusal(policy, { email: null, emailVerified, groups: null }),
      ).not.toBeNull();
    }
  });

  it("matches the domain after the last @, case-insensitively and exactly", () => {
    const policy = { ...open, allowedEmailDomains: ["corp.example"] };
    const verdict = (email: unknown) =>
      admissionRefusal(policy, { email, groups: null });
    expect(verdict("a@CORP.example")).toBeNull();
    expect(verdict('"x@corp.example"@evil.test')).not.toBeNull();
    expect(verdict("a@corp.example.evil.test")).not.toBeNull();
    expect(verdict("corp.example")).not.toBeNull();
    expect(verdict(undefined)).not.toBeNull();
  });

  it("takes groups as an array, a bare string, or a comma list", () => {
    const policy = { ...open, allowedGroups: ["ops"] };
    const verdict = (groups: unknown) =>
      admissionRefusal(policy, { email: null, groups });
    expect(verdict(["dev", "ops"])).toBeNull();
    expect(verdict("ops")).toBeNull();
    expect(verdict("dev, ops")).toBeNull();
    expect(verdict(["Ops"])).not.toBeNull();
    expect(verdict([])).not.toBeNull();
    expect(verdict({ ops: true })).not.toBeNull();
  });
});
