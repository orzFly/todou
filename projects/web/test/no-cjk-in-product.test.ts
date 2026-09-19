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
 * It lives in web but scans all four packages, so a change confined to
 * server, cli or shared never triggers it on its own: running just that
 * package's suite leaves this silent, and only a full run answers for it.
 *
 * Its blind spots, stated so nobody mistakes it for a proof:
 * - Only `.ts`, `.tsx`, `.css` and each package's `index.html` are read.
 *   Nothing under a `src/` tree is anything else today, and no product
 *   module imports a `.md` or `.json`, so widening it would pull in data
 *   and fixtures rather than copy.
 * - Text that reaches the screen from anywhere but these files — the
 *   database, a fixture, a dependency — is outside its reach entirely.
 * - HTML comments are not recognised, so CJK in one is reported as copy.
 *   That errs loud, which is the safe direction.
 * - Regex literals are not recognised, so a backtick inside one reads as a
 *   template opening, and an interpolation holding its own backtick ends
 *   the template early. Either way the rest of the file is parsed against
 *   the wrong state, which can err in both directions — so a file that
 *   ends mid-comment or mid-template is reported by UNPARSED below rather
 *   than trusted.
 *
 * Two deliberate uses of 土豆 sit outside the scan and should stay: the
 * root README's opening line and package.json's description both explain
 * that "todou" reads as To-Do and sounds like the word for potato. The
 * characters are what the sentence is about, so there is nothing to
 * translate.
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

/**
 * Files the scanner cannot follow to the end, each with what defeats it.
 * Their lines are read raw instead, so their comments are searched along
 * with their code: over-reporting a comment is an argument, while skipping
 * a template's copy is a hole nobody sees.
 *
 * Fixing the source is not the point of an entry here — these regexes are
 * written correctly, and escaping a backtick to suit a test would be the
 * tail wagging the dog. An entry records that one file's stripping is not
 * to be trusted.
 */
const UNPARSED: Array<{ file: string; reason: string }> = [
  {
    file: "cli/src/resolve.ts",
    reason:
      "`shellArg` nests a template inside its own interpolation, which " +
      "closes the outer one early",
  },
  {
    file: "server/src/http/content-disposition.ts",
    reason: "RFC 5987's attr-char set lists a backtick inside a regex class",
  },
  {
    file: "shared/src/resolve-links.ts",
    reason: "the markdown fence regex matches a run of backticks",
  },
  {
    file: "web/src/lib/slash-commands.ts",
    reason: "the markdown fence regex matches a run of backticks",
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

function productFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(PROJECTS, entry.name, "src");
    try {
      if (statSync(src).isDirectory()) out.push(...sourceFiles(src));
    } catch {
      // A package without a src/ tree has nothing to say here.
    }
    // The page shell sits beside src/, and its <title> is the first product
    // copy a reader ever sees.
    const page = join(PROJECTS, entry.name, "index.html");
    try {
      if (statSync(page).isFile()) out.push(page);
    } catch {
      // Only the browser package ships one.
    }
  }
  return out;
}

/**
 * Blanks out comment spans, keeping every other character where it is so a
 * line's remainder can still be tested. Deciding by line prefix instead is
 * what let the CLI's `--help` text through: it is a template literal full of
 * markdown, and a bullet opens with `*` exactly as a JSDoc continuation
 * does, so product copy read as a comment.
 */
function codeOnly(source: string): { code: string[]; balanced: boolean } {
  let block = false;
  let template = false;
  const code = source.split("\n").map((raw) => {
    let kept = "";
    // A plain string cannot span lines, so it never survives into the next.
    let quote: string | null = null;
    for (let i = 0; i < raw.length; i++) {
      const char = raw[i] as string;
      const pair = char + (raw[i + 1] ?? "");
      if (block) {
        if (pair === "*/") {
          block = false;
          i++;
        }
        continue;
      }
      if (char === "\\" && (quote !== null || template)) {
        kept += char + (raw[i + 1] ?? "");
        i++;
        continue;
      }
      if (quote !== null) {
        kept += char;
        if (char === quote) quote = null;
        continue;
      }
      if (template) {
        kept += char;
        if (char === "`") template = false;
        continue;
      }
      if (pair === "//") break;
      if (pair === "/*") {
        block = true;
        i++;
        continue;
      }
      if (char === "`") template = true;
      else if (char === "'" || char === '"') quote = char;
      kept += char;
    }
    return kept;
  });
  // Ending inside a comment or a template means some earlier character was
  // misread, so every line after it was measured against the wrong state.
  return { code, balanced: !block && !template };
}

const SCANNED = productFiles().map((path) => {
  const source = readFileSync(path, "utf8");
  const { code, balanced } = codeOnly(source);
  const raw = source.split("\n");
  return {
    file: relative(PROJECTS, path).replaceAll("\\", "/"),
    raw,
    code: balanced ? code : raw,
    balanced,
  };
});

const FOUND: Line[] = SCANNED.flatMap(({ file, raw, code }) =>
  raw.flatMap((text, index) =>
    CJK.test(code[index] ?? "")
      ? [{ file, line: index + 1, text: text.trim() }]
      : [],
  ),
);

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

  it("says so when its own scan loses the thread", () => {
    const known = new Set(UNPARSED.map((entry) => entry.file));
    const surprises = SCANNED.filter(
      ({ file, balanced }) => !balanced && !known.has(file),
    ).map(({ file }) => file);
    expect(
      surprises,
      "The scan of these files ended inside a comment or a template, so " +
        "everything after the character it misread was measured against " +
        "the wrong state — quietly, in both directions. Find what it could " +
        "not follow (a backtick in a regex, a nested interpolation) and " +
        "add the file to UNPARSED above with that reason:\n" +
        surprises.join("\n"),
    ).toEqual([]);

    const settled = UNPARSED.map((entry) => entry.file).filter((file) =>
      SCANNED.some((scan) => scan.file === file && scan.balanced),
    );
    expect(
      settled,
      "These parse cleanly now, so the scanner can strip their comments " +
        "again; drop them from UNPARSED and let them be read like every " +
        "other file:\n" +
        settled.join("\n"),
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
