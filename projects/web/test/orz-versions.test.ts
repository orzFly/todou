import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// @orz/ui pins @orz/themes and @orz/query to its own exact version. A direct
// dependency on any other version installs a second copy, and theme data from
// one copy is then foreign to the store of the other. The same holds across
// packages: shared's @orz/query is the one web hands its schema to, so a
// package on another version is a second copy too.
function orzVersionProblems(packages: Record<string, Manifest>): string[] {
  const entries = Object.entries(packages).flatMap(([pkg, manifest]) =>
    [
      ...Object.entries(manifest.dependencies ?? {}),
      ...Object.entries(manifest.devDependencies ?? {}),
    ]
      .filter(([name]) => name.startsWith("@orz/"))
      .map(([name, version]) => ({ pkg, name, version })),
  );
  const problems = entries
    .filter(({ version }) => !EXACT.test(version))
    .map(
      ({ pkg, name, version }) =>
        `${pkg}: ${name}: "${version}" is not an exact version`,
    );
  const versions = new Set(entries.map(({ version }) => version));
  if (versions.size > 1)
    problems.push(
      `@orz/* versions differ: ${entries.map(({ pkg, name, version }) => `${pkg} ${name}@${version}`).join(", ")}`,
    );
  return problems;
}

// Not `import.meta.url`: under this setup that is not a `file:` URL.
const projects = resolve(process.cwd(), "..");
const manifests: Record<string, Manifest> = Object.fromEntries(
  readdirSync(projects)
    .filter((dir) => existsSync(join(projects, dir, "package.json")))
    .map((dir) => [
      dir,
      JSON.parse(readFileSync(join(projects, dir, "package.json"), "utf8")),
    ]),
);

describe("@orz/* dependency versions", () => {
  it("are one exact version across every package", () => {
    expect(Object.keys(manifests)).toEqual(
      expect.arrayContaining(["cli", "server", "shared", "web"]),
    );
    expect(
      Object.keys(manifests.web?.dependencies ?? {}).filter((n) =>
        n.startsWith("@orz/"),
      ),
    ).toEqual(expect.arrayContaining(["@orz/ui", "@orz/themes", "@orz/query"]));
    expect(orzVersionProblems(manifests)).toEqual([]);
  });

  const version = manifests.web?.dependencies?.["@orz/ui"] ?? "0.0.0";

  it("reports a sibling on another version, and a range", () => {
    const drifted = orzVersionProblems({
      web: { dependencies: { "@orz/ui": version, "@orz/themes": "0.1.1" } },
    });
    expect(drifted).toEqual([expect.stringMatching(/versions differ/)]);
    const ranged = orzVersionProblems({
      web: {
        dependencies: {
          "@orz/ui": `^${version}`,
          "@orz/themes": `^${version}`,
        },
      },
    });
    expect(ranged).toEqual([
      expect.stringMatching(/web: @orz\/ui: .* not an exact version/),
      expect.stringMatching(/web: @orz\/themes: .* not an exact version/),
    ]);
  });

  it("reports two packages that agree within themselves but not with each other", () => {
    const split = orzVersionProblems({
      web: {
        dependencies: {
          "@orz/ui": version,
          "@orz/themes": version,
          "@orz/query": version,
        },
      },
      shared: { dependencies: { "@orz/query": "0.1.1" } },
    });
    expect(split).toEqual([
      expect.stringMatching(/versions differ: .*shared @orz\/query@0\.1\.1/),
    ]);
  });
});
