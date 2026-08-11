import { TODOU } from "@todou/shared";
import { expect, it } from "vitest";

it("consumes @todou/shared TypeScript source directly", () => {
  expect(TODOU).toBe("todou");
});
