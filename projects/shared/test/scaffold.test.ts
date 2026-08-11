import { expect, it } from "vitest";
import { TODOU } from "../src/index.ts";

it("exports the package marker", () => {
  expect(TODOU).toBe("todou");
});
