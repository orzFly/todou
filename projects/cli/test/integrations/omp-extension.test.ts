import { describe, expect, it } from "vitest";
import { OMP_EXTENSION_SOURCE } from "../../src/integrations/omp/extension.generated.ts";
import { MAX_PAYLOAD_CHARS } from "../../src/peer-push.ts";

/** The literal as the extension spells it, underscores and all. */
function declared(name: string): number | undefined {
  const found = new RegExp(`const ${name} = ([0-9_]+);`).exec(
    OMP_EXTENSION_SOURCE,
  );
  return found ? Number(found[1]?.replaceAll("_", "")) : undefined;
}

describe("the omp extension's half of the push protocol", () => {
  /**
   * The extension runs inside omp and can import nothing from this package,
   * so the frame cap exists twice. Disagreement is invisible from both ends:
   * over its own cap the sender re-renders the batch as a cursor line, and a
   * receiver that stops earlier destroys the connection without a receipt —
   * which the sender reads as a delivery. This is the only thing that says so.
   */
  it("caps a frame where the sender does", () => {
    expect(declared("MAX_PAYLOAD_CHARS")).toBe(MAX_PAYLOAD_CHARS);
  });

  /**
   * Not a style rule: an import of anything outside node: would resolve
   * inside this repo and be missing wherever the file is actually installed.
   */
  it("imports nothing but Node built-ins", () => {
    const imported = [...OMP_EXTENSION_SOURCE.matchAll(/from "([^"]+)"/g)].map(
      (found) => found[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((from) => !from?.startsWith("node:"))).toEqual([]);
  });
});
