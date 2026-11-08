import { describe, expect, it } from "vitest";
import { isSameSitePath } from "../src/index.ts";

// The browser is the oracle: resolve the value against a real page address
// and see which host it lands on.
const lands = (value: string) =>
  new URL(value, "https://todou.example/login?redirect=x").host;

describe("isSameSitePath", () => {
  for (const value of [
    "/",
    "/projects",
    "/cli-auth?port=4711&state=abc",
    "/projects/todou/issues/12?tab=timeline#comment-3",
    "/projects/todou/issues?q=a%5Cb",
    "/projects/todou/issues?q=a\\b",
    "/projects/%E4%B8%AD%E6%96%87",
    "/projects/中文",
    "/.//evil.example",
    "/%2F%2Fevil.example",
  ]) {
    it(`keeps ${JSON.stringify(value)}`, () => {
      expect(lands(value)).toBe("todou.example");
      expect(isSameSitePath(value)).toBe(true);
    });
  }

  for (const value of [
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "https://evil.example/phish",
    "http:evil.example",
  ]) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      expect(lands(value)).not.toBe("todou.example");
      expect(isSameSitePath(value)).toBe(false);
    });
  }

  it("refuses values that stay on site but the app never produces", () => {
    expect(isSameSitePath("projects")).toBe(false);
    expect(isSameSitePath("")).toBe(false);
    expect(isSameSitePath("/x\r\nSet-Cookie: a=b")).toBe(false);
    expect(isSameSitePath("/x\u0000y")).toBe(false);
    expect(isSameSitePath(42)).toBe(false);
    expect(isSameSitePath(undefined)).toBe(false);
  });
});
