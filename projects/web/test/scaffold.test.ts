import { TODOU } from "@todou/shared";
import { expect, it } from "vitest";
import { App } from "../src/App.tsx";

it("App component is defined", () => {
  expect(App).toBeTypeOf("function");
});

it("consumes @todou/shared TypeScript source directly", () => {
  expect(TODOU).toBe("todou");
});
