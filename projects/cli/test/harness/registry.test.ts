import { HARNESS_IDS } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { HARNESSES } from "../../src/harness/index.ts";

describe("harness registry", () => {
  it("has exactly one detector per shared harness id", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect([...ids].sort()).toEqual([...HARNESS_IDS].sort());
  });
});
