import { describe, expect, it } from "vitest";
import { Login, LoginInput } from "../src/schemas/user.ts";

describe("LoginInput (not all digits)", () => {
  it("accepts the shapes a login has always allowed", () => {
    expect(LoginInput.parse("alice")).toBe("alice");
    expect(LoginInput.parse("bot-1")).toBe("bot-1");
    expect(LoginInput.parse("a1")).toBe("a1");
  });

  it("rejects an all-digit login, naming the rule", () => {
    for (const bad of ["123", "0"]) {
      const result = LoginInput.safeParse(bad);
      expect(result.success).toBe(false);
      expect(
        result.success === false &&
          result.error.issues.some((issue) =>
            issue.message.includes("not all digits"),
          ),
      ).toBe(true);
    }
  });

  it("keeps Login itself able to read the historical data", () => {
    // An all-digit login may already sit in the database; reading one back
    // must not fail — only creating and renaming are fenced off.
    expect(Login.parse("123")).toBe("123");
  });
});
