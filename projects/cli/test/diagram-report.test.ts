import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyLocation } from "../src/body.ts";
import {
  type DocLocation,
  type FixHint,
  reportDiagramProblems,
} from "../src/diagram-report.ts";
import type { DiagramResult } from "../src/mermaid/types.ts";

// Scratch files land in os.tmpdir(), which follows TMPDIR; pointing it at a
// directory of our own keeps them inside what this run removes.
const root = mkdtempSync(join(tmpdir(), "todou-diagram-report-"));
const scratchRoot = join(root, "tmp");
mkdirSync(scratchRoot);
vi.stubEnv("TMPDIR", scratchRoot);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const entry of readdirSync(scratchRoot)) {
    rmSync(join(scratchRoot, entry), { recursive: true, force: true });
  }
});

const BAD_MESSAGE = "Parse error on line 3:\n...Saved(Config)| C\n-----^";

/** A parser that fails every diagram containing "BAD", at `line`. */
function fakeParser(line: number | null = 3) {
  const calls: string[][] = [];
  const parser = async () => async (sources: string[]) => {
    calls.push(sources);
    return sources.map(
      (source): DiagramResult =>
        source.includes("BAD")
          ? { ok: false, message: BAD_MESSAGE, line }
          : { ok: true },
    );
  };
  return { parser, calls };
}

const COMMENT: FixHint = {
  kind: "comment",
  project: "todou",
  number: 7,
  commentId: 42,
};

async function report(
  docs: Array<{ text: string; location: DocLocation }>,
  options: { fix?: FixHint; line?: number | null } = {},
) {
  const lines: string[] = [];
  const { parser, calls } = fakeParser(options.line);
  const result = await reportDiagramProblems({
    docs,
    fix: options.fix ?? COMMENT,
    note: (line) => lines.push(line),
    paint: (_style, text) => text,
    parser,
  });
  return { ...result, lines, calls };
}

// The broken block's content starts on line 7 of this document.
const MIXED =
  "# Title\n\n```mermaid\nflowchart LR\n```\n```mermaid\nBAD\n```\n";

describe("reportDiagramProblems", () => {
  it("does not load the parser for a body without diagrams", async () => {
    const out = await report([
      {
        text: "no diagrams\n```ts\nx\n```",
        location: { kind: "scratch", name: "c.md" },
      },
    ]);
    expect(out.calls).toEqual([]);
    expect(out.lines).toEqual([]);
    expect(out.broken).toBe(0);
  });

  it("prints nothing and writes nothing when every diagram parses", async () => {
    const out = await report([
      {
        text: "```mermaid\nflowchart LR\n```",
        location: { kind: "scratch", name: "c.md" },
      },
    ]);
    expect(out.calls).toEqual([["flowchart LR"]]);
    expect(out.lines).toEqual([]);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("points at a --body-file as typed, with the document's line", async () => {
    const out = await report([
      { text: MIXED, location: { kind: "file", path: "notes/body.md" } },
    ]);
    expect(out.broken).toBe(1);
    expect(out.lines).toEqual([
      "warning: 1 of 2 mermaid diagrams fails to parse — the web shows its source and this error instead of the diagram",
      "  notes/body.md:9",
      "    Parse error on line 3:",
      "    ...Saved(Config)| C",
      "    -----^",
      "  the comment is posted; fix the file and update it:",
      "    todou comment edit 7 42 -p todou --body-file notes/body.md",
    ]);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("points at the block's first line when the error has no line", async () => {
    const out = await report(
      [{ text: MIXED, location: { kind: "file", path: "b.md" } }],
      { line: null },
    );
    expect(out.lines[1]).toBe("  b.md:7");
  });

  it("writes a scratch body out byte for byte and points at it", async () => {
    const text = `${MIXED}trailing — ünïcode\r\n`;
    const out = await report([
      { text, location: { kind: "scratch", name: "comment-42.md" } },
    ]);
    const [dir] = readdirSync(scratchRoot);
    expect(dir).toMatch(/^todou-body-/);
    const path = join(scratchRoot, dir, "comment-42.md");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(out.lines[1]).toBe(`  ${path}:9`);
    expect(out.lines.at(-1)).toBe(
      `    todou comment edit 7 42 -p todou --body-file ${path}`,
    );
  });

  it("names spec files by their path in the set", async () => {
    const out = await report(
      [
        {
          text: "```mermaid\nflowchart LR\n```",
          location: { kind: "spec", path: "plan.md" },
        },
        { text: MIXED, location: { kind: "spec", path: "sub/design.md" } },
        {
          text: "```mermaid\nBAD\n```",
          location: { kind: "spec", path: "api.md" },
        },
      ],
      { fix: { kind: "spec" } },
    );
    expect(out.broken).toBe(2);
    expect(out.lines[0]).toBe(
      "warning: 2 of 4 mermaid diagrams fail to parse — the web shows their source and these errors instead of the diagrams",
    );
    expect(out.lines).toContain("  sub/design.md:9");
    expect(out.lines).toContain("  api.md:4");
    expect(out.lines.at(-1)).toBe(
      "  the spec is pushed; fix the diagrams and push again",
    );
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("gives an issue body its own update command", async () => {
    const out = await report(
      [
        {
          text: "```mermaid\nBAD\n```",
          location: { kind: "file", path: "my body.md" },
        },
      ],
      { fix: { kind: "issue", project: "todou", number: 9 } },
    );
    expect(out.lines[0]).toBe(
      "warning: 1 mermaid diagram fails to parse — the web shows its source and this error instead of the diagram",
    );
    expect(out.lines.slice(-2)).toEqual([
      "  the issue is saved; fix the file and update it:",
      "    todou issue edit 9 -p todou --body-file 'my body.md'",
    ]);
  });

  it("says in one line that the check itself failed", async () => {
    const lines: string[] = [];
    const result = await reportDiagramProblems({
      docs: [{ text: MIXED, location: { kind: "file", path: "b.md" } }],
      fix: COMMENT,
      note: (line) => lines.push(line),
      paint: (_style, text) => text,
      parser: async () => {
        throw new Error("registerHooks is not a function");
      },
    });
    expect(result.broken).toBe(0);
    expect(lines).toEqual([
      "could not check mermaid diagrams: registerHooks is not a function",
    ]);
  });
});

describe("bodyLocation", () => {
  const file = join(root, "body.md");
  writeFileSync(file, "x");

  it("returns a real --body-file as typed", () => {
    expect(bodyLocation({ bodyFile: "body.md", cwd: root })).toEqual({
      kind: "file",
      path: "body.md",
    });
    expect(bodyLocation({ bodyFile: file, cwd: "/" })).toEqual({
      kind: "file",
      path: file,
    });
  });

  it("returns null for stdin, stream paths and --body", () => {
    expect(bodyLocation({ bodyFile: "-", cwd: root })).toBeNull();
    expect(bodyLocation({ bodyFile: "/dev/fd/63", cwd: root })).toBeNull();
    expect(bodyLocation({ bodyFile: "/proc/self/fd/0", cwd: root })).toBeNull();
    expect(bodyLocation({ body: "inline", cwd: root })).toBeNull();
    expect(bodyLocation({ cwd: root })).toBeNull();
  });

  it("returns null for a path that is not a regular file", () => {
    expect(bodyLocation({ bodyFile: root, cwd: "/" })).toBeNull();
    expect(bodyLocation({ bodyFile: "missing.md", cwd: root })).toBeNull();
  });
});
