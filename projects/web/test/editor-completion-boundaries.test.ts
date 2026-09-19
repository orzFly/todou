import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A source-text guard for this directory's current style: standalone comments,
// static ESM declarations, unaliased named imports and direct panel calls.
// This is not a TypeScript parser or a transitive dependency analysis. Indirect
// calls, dynamic module forwarding and other source layouts need a new guard.
function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8")
    .replace(/^[\t ]*\/\*[\s\S]*?\*\//gm, "")
    .replace(/^[\t ]*\/\/.*$/gm, "");
}

function declarations(source: string) {
  return Array.from(
    source.matchAll(
      /^[\t ]*(import|export)\s+(?:([^;"']*?)\s+from\s+)?["']([^"'\r\n]+)["']\s*;?/gm,
    ),
    (match) => ({
      kind: match[1],
      clause: match[2]?.trim() ?? "",
      module: match[3],
    }),
  );
}

function namedMembers(clause: string): string[] {
  // Fail on namespace/default imports instead of silently missing their calls.
  expect(clause).toMatch(/^(?:type\s+)?\{[\s\S]*\}$/);
  return clause
    .replace(/^(?:type\s+)?\{/, "")
    .replace(/\}$/, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

const shared = readSource("../src/lib/ref-completion.ts");
const adapter = readSource("../src/lib/editor/ref-completion.ts");
const editorFiles = readdirSync(resolve(process.cwd(), "src/lib/editor"), {
  recursive: true,
  encoding: "utf8",
})
  .filter((name) => /\.tsx?$/.test(name))
  .map((name) => ({
    name,
    source: readSource(`../src/lib/editor/${name}`),
  }));

function completionBody(): { parameter: string; body: string } {
  const match =
    /^export function completionWith\s*\(\s*(\w+)\s*:[^{]*\{([\s\S]*?)^\}/m.exec(
      adapter,
    );
  if (!match?.[1] || !match[2]) {
    throw new Error("completionWith must declare caller sources and a body");
  }
  return { parameter: match[1], body: match[2] };
}

// File reads are invisible to related-test selection; run this file explicitly.
describe("editor completion boundaries", () => {
  it("keeps shared reference imports and re-exports in the domain layer", () => {
    const dependencies = declarations(shared);
    expect(dependencies.length).toBeGreaterThan(0);
    expect(
      dependencies.filter((entry) => entry.module !== "@todou/shared"),
    ).toEqual([]);
    // Every line-start import must be understood, including type-only imports.
    expect(
      dependencies.filter((entry) => entry.kind === "import"),
    ).toHaveLength(Array.from(shared.matchAll(/^[\t ]*import\b/gm)).length);
    // Dynamic imports, import types and CommonJS require are outside this layer.
    expect(shared).not.toMatch(/\b(?:import|require)\s*\(/);
  });

  it("keeps the direct autocompletion call solely in completionWith", () => {
    const importers = editorFiles.flatMap(({ name, source }) =>
      declarations(source)
        .filter((entry) => entry.module === "@codemirror/autocomplete")
        .flatMap((entry) =>
          namedMembers(entry.clause)
            .filter((member) => /\bautocompletion\b/.test(member))
            .map((member) => {
              expect(member).toBe("autocompletion");
              return name;
            }),
        ),
    );
    expect(importers).toEqual(["ref-completion.ts"]);
    const calls = /\bautocompletion\s*\(/g;
    expect(
      editorFiles.flatMap(({ source }) => Array.from(source.matchAll(calls))),
    ).toHaveLength(1);
    expect(Array.from(completionBody().body.matchAll(calls))).toHaveLength(1);
  });

  it("assembles tag completion and caller sources in the same override", () => {
    const tagImport = declarations(adapter).find(
      (entry) => entry.module === "@/lib/editor/tag-completion.ts",
    );
    expect(namedMembers(tagImport?.clause ?? "")).toContain(
      "tagCompletionSource",
    );
    const { parameter, body } = completionBody();
    const override =
      /\bautocompletion\s*\(\s*\{[^}]*?\boverride\s*:\s*\[([^\]]*)\]/.exec(
        body,
      );
    expect(override).not.toBeNull();
    const sources = (override?.[1] ?? "")
      .split(",")
      .map((source) => source.replace(/\s+/g, ""))
      .filter(Boolean);
    // Sorting unfiltered sources is order-sensitive in the locked CM version.
    // Keep this structural assertion even if an upstream change masks it in UI.
    expect(sources).toEqual(["tagCompletionSource", `...${parameter}`]);
  });
});
