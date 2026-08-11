import { TODOU } from "@todou/shared";
import { expect, it } from "vitest";
import { cn } from "../src/lib/utils.ts";

it("consumes @todou/shared TypeScript source directly", () => {
  expect(TODOU).toBe("todou");
});

it("merges tailwind classes via cn", () => {
  expect(cn("p-2", "p-4")).toBe("p-4");
});
