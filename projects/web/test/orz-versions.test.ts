import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// @orz/ui pins @orz/themes (and its other @orz siblings) to its own exact
// version. A direct dependency on any other version installs a second copy,
// and theme data from one copy is then foreign to the store of the other.
function orzVersionProblems(pkg: Manifest): string[] {
  const entries = [
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
  ].filter(([name]) => name.startsWith("@orz/"));
  const problems = entries
    .filter(([, version]) => !EXACT.test(version))
    .map(([name, version]) => `${name}: "${version}" is not an exact version`);
  const versions = new Set(entries.map(([, version]) => version));
  if (versions.size > 1)
    problems.push(
      `@orz/* versions differ: ${entries.map(([n, v]) => `${n}@${v}`).join(", ")}`,
    );
  return problems;
}

// Not `import.meta.url`: under this setup that is not a `file:` URL.
const manifest: Manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
);

describe("@orz/* dependency versions", () => {
  it("are one exact version across package.json", () => {
    expect(
      Object.keys(manifest.dependencies ?? {}).filter((n) =>
        n.startsWith("@orz/"),
      ),
    ).toEqual(expect.arrayContaining(["@orz/ui", "@orz/themes"]));
    expect(orzVersionProblems(manifest)).toEqual([]);
  });

  it("reports a sibling on another version, and a range", () => {
    const version = manifest.dependencies?.["@orz/ui"] ?? "0.0.0";
    const drifted = orzVersionProblems({
      dependencies: { "@orz/ui": version, "@orz/themes": "0.1.1" },
    });
    expect(drifted).toEqual([expect.stringMatching(/versions differ/)]);
    const ranged = orzVersionProblems({
      dependencies: { "@orz/ui": `^${version}`, "@orz/themes": `^${version}` },
    });
    expect(ranged).toEqual([
      expect.stringMatching(/@orz\/ui: .* not an exact version/),
      expect.stringMatching(/@orz\/themes: .* not an exact version/),
    ]);
  });
});
