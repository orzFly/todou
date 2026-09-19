import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OMP_EXTENSION_SOURCE } from "../../src/integrations/omp/extension.generated.ts";
import { PI_EXTENSION_SOURCE } from "../../src/integrations/pi/extension.generated.ts";

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

  it("keeps omp verbatim and bundles the Pi adapter with the shared core", () => {
    const integrations = join(import.meta.dirname, "../../src/integrations");
    expect(OMP_EXTENSION_SOURCE).toBe(
      readFileSync(join(integrations, "omp/extension.ts"), "utf8"),
    );
    expect(PI_EXTENSION_SOURCE).toContain("TODOU_PI_STATE");
    expect(PI_EXTENSION_SOURCE).toContain("todou_watch");
    const imports = [...PI_EXTENSION_SOURCE.matchAll(/from ["']([^"']+)["']/g)];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((match) => match[1]?.startsWith("node:"))).toBe(true);
  });
});
