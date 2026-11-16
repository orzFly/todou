import { describe, expect, it } from "vitest";
import { fenceTitle } from "../src/lib/fence-meta.ts";

describe("fenceTitle", () => {
  it.each([
    ['title="a b.ts"', "a b.ts"],
    ["title='x.ts'", "x.ts"],
    ["title=x.ts", "x.ts"],
    ["compose.yaml", "compose.yaml"],
    ["compose.yaml {1,3}", "compose.yaml"],
    ['{1,3} title="x.ts"', "x.ts"],
    ["{1,3}", undefined],
    ["linenos=true", undefined],
    // A bare word is always taken as a filename; accepted.
    ["showLineNumbers", "showLineNumbers"],
    ["", undefined],
    ["   ", undefined],
    [undefined, undefined],
  ])("%j → %j", (meta, title) => {
    expect(fenceTitle(meta)).toBe(title);
  });
});
