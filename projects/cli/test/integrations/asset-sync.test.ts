import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const generator = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "gen-integration-assets.mjs",
);

describe("integration assets", () => {
  /**
   * The one thing keeping two copies of the same file honest (T-308). An
   * extension edited without regenerating is a CLI that installs the previous
   * version — with nothing failing, because the copy that is compiled and
   * linted is the one nobody ships.
   */
  it("are regenerated from their sources", () => {
    // `--check` writes nothing and exits 1 on drift, naming the stale file.
    expect(() =>
      execFileSync("node", [generator, "--check"], { encoding: "utf8" }),
    ).not.toThrow();
  });
});
