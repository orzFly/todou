import { cn } from "@orz/ui";
import { TODOU } from "@todou/shared";
import { expect, it } from "vitest";

it("consumes @todou/shared TypeScript source directly", () => {
  expect(TODOU).toBe("todou");
});

it("merges tailwind classes via cn", () => {
  expect(cn("p-2", "p-4")).toBe("p-4");
});
