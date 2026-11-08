import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Version strings are compared as strings across machines, and git's automatic
// abbreviation length follows each repository's object count, so a local build
// and the host checkout drift apart unless every call pins the length (T-672).
const root = fileURLToPath(new URL("../../..", import.meta.url));

function describeLines(): string[] {
  const grep = spawnSync(
    "git",
    [
      "grep",
      "-nE",
      'describe.*--tags|"describe", "--tags"',
      "--",
      ".",
      ":!docs/releases/",
      // The pattern above is itself a match once this file is tracked.
      ":!projects/shared/test/describe-abbrev.guard.test.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  // Status 1 is "no match": left to the count below, so a pattern that has
  // stopped matching fails as such instead of as a crashed command.
  if (grep.status !== 0 && grep.status !== 1) {
    throw new Error(`git grep exited ${grep.status}: ${grep.stderr}`);
  }
  return grep.stdout.split("\n").filter((line) => line !== "");
}

describe("git describe abbreviation", () => {
  it("pins every git describe to a 9-character hash", () => {
    const lines = describeLines();
    expect(lines.length).toBeGreaterThanOrEqual(13);
    expect(lines.filter((line) => !line.includes("--abbrev=9"))).toEqual([]);
  });

  it("does not take the nix version from the 7-character shortRev", () => {
    expect(readFileSync(`${root}/flake.nix`, "utf8")).not.toContain("shortRev");
  });
});
