import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Anchored on the package directory vitest runs from, not on
// `import.meta.url`: under this setup that is not a `file:` URL, so the
// path helpers reject it.
const PROJECTS = resolve(process.cwd(), "..");

/**
 * The product speaks English (T-448). This reads every package's source as
 * text rather than importing it, so it sees strings no test happens to
 * render — which is also why no module graph reaches it and `vitest related`
 * can never list it. It has to be run on purpose.
 *
 * Its blind spots, stated so nobody mistakes it for a proof: a line counts as
 * a comment by its first characters alone, so CJK trailing a statement is
 * reported as product copy and CJK inside a `/* *\/` block whose continuation
 * lines carry no `*` is missed; and text that reaches the screen from
 * anywhere but these files — the database, a fixture, a dependency — is
 * outside its reach entirely.
 */
const EXTENSIONS = /\.(?:tsx?|css)$/;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/**
 * Lines that carry CJK on purpose, each with the reason and quoted exactly as
 * the source trims to. Adding one is the deliberate act this guard exists to
 * force; the way past it is a wrong line, not a missing one.
 *
 * Emoji are not CJK and need no entry — the potato stays.
 */
const DECLARED: Array<{ file: string; reason: string; lines: string[] }> = [
  {
    file: "web/src/lib/editor/completion-space.ts",
    reason:
      "the characters the rule matches on, not words anybody reads: CJK " +
      "closing punctuation takes no space before it, which is the whole " +
      "question this regex answers",
    lines: [
      "const ATTACHES_LEFT = /^(?:[\\p{Pe}\\p{Pf}]|[,.;:!?~，。、；：！？～…])$/u;",
    ],
  },
];

type Line = { file: string; line: number; text: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (EXTENSIONS.test(entry.name)) out.push(path);
  }
  return out;
}

function packageSources(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(PROJECTS, entry.name, "src");
    try {
      if (statSync(src).isDirectory()) out.push(...sourceFiles(src));
    } catch {
      // A package without a src/ tree has nothing to say here.
    }
  }
  return out;
}

const isComment = (text: string) =>
  text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");

const FOUND: Line[] = packageSources()
  .flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((raw, index) => ({
        file: relative(PROJECTS, path).replaceAll("\\", "/"),
        line: index + 1,
        text: raw.trim(),
      })),
  )
  .filter(({ text }) => CJK.test(text) && !isComment(text));

const declaredIn = (file: string) =>
  DECLARED.find((entry) => entry.file === file)?.lines ?? [];

describe("the product interface is written in English", () => {
  it("leaves no undeclared CJK in any package's source", () => {
    const offenders = FOUND.filter(
      ({ file, text }) => !declaredIn(file).includes(text),
    ).map(({ file, line, text }) => `${file}:${line}  ${text}`);
    expect(
      offenders,
      "These source lines put CJK where a reader can reach it. The product " +
        "speaks English, so translate the string — carrying the voice over, " +
        "not flattening it to a default — or, if the characters are data " +
        "the code reasons about rather than words anybody reads, add the " +
        "line to DECLARED above with the reason:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps the declared list from rotting", () => {
    const stale = DECLARED.flatMap(({ file, lines }) =>
      lines
        .filter(
          (text) =>
            !FOUND.some((found) => found.file === file && found.text === text),
        )
        .map((text) => `${file}  ${text}`),
    );
    expect(
      stale,
      "These declared lines no longer exist, or no longer carry CJK. Drop " +
        "them from DECLARED so the list keeps meaning what it says — a " +
        "stale exception is a hole nobody can see:\n" +
        stale.join("\n"),
    ).toEqual([]);
  });
});
