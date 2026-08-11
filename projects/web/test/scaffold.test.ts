import { expect, it } from "vitest";
import { App } from "../src/App.tsx";

it("App component is defined", () => {
  expect(App).toBeTypeOf("function");
});
