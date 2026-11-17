import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyLocation } from "./body.ts";
import type { Painter } from "./format.ts";
import { findMermaidFences } from "./mermaid/fences.ts";
import { loadDiagramParser } from "./mermaid/parser.ts";
import type { DiagramParser } from "./mermaid/types.ts";

/**
 * Where a checked text can be fixed. `file` is the user's own `--body-file`,
 * printed as they typed it; `scratch` is a body that came from no file the
 * user can edit — `--body`, stdin, `<(…)` — and is written out under that
 * name only once a diagram in it is known to be broken; `spec` is a path
 * inside a spec set.
 */
export type DocLocation =
  | { kind: "file"; path: string }
  | { kind: "spec"; path: string }
  | { kind: "scratch"; name: string };

/**
 * A written body and where it can be fixed: the `--body-file` it came from,
 * or else a scratch file of this name.
 */
export function bodyDoc(
  text: string,
  flags: { body?: string; bodyFile?: string; context: { cwd: string } },
  scratchName: string,
): { text: string; location: DocLocation } {
  return {
    text,
    location: bodyLocation({
      body: flags.body,
      bodyFile: flags.bodyFile,
      cwd: flags.context.cwd,
    }) ?? { kind: "scratch", name: scratchName },
  };
}

export type FixHint =
  | { kind: "comment"; project: string; number: number; commentId: number }
  | { kind: "issue"; project: string; number: number }
  | { kind: "spec" };

/**
 * Checks every mermaid block in what was just written and, when one does not
 * parse, says so on stderr with where to fix it and how to update the write.
 * The write has already happened and nothing here can undo or fail it:
 * a parser that cannot load costs one line, never the exit code.
 *
 * The check is best-effort. The CLI's mermaid may not be the web's version,
 * so a rare diagram is reported differently from how the web renders it.
 */
export async function reportDiagramProblems(args: {
  docs: Array<{ text: string; location: DocLocation }>;
  fix: FixHint;
  note: (line: string) => void;
  paint: Painter;
  parser?: () => Promise<DiagramParser>;
}): Promise<{ broken: number }> {
  const blocks = args.docs.flatMap((doc) =>
    findMermaidFences(doc.text).map((fence) => ({ doc, fence })),
  );
  if (blocks.length === 0) return { broken: 0 };

  let results: Awaited<ReturnType<DiagramParser>>;
  try {
    const parse = await (args.parser ?? loadDiagramParser)();
    results = await parse(blocks.map((block) => block.fence.source));
  } catch (error) {
    args.note(
      `could not check mermaid diagrams: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { broken: 0 };
  }

  const failures = blocks.flatMap((block, i) => {
    const result = results[i];
    return result?.ok === false ? [{ ...block, result }] : [];
  });
  if (failures.length === 0) return { broken: 0 };

  const paths = new Map<DocLocation, string>();
  let scratchDir: string | undefined;
  const pathOf = (doc: { text: string; location: DocLocation }): string => {
    const known = paths.get(doc.location);
    if (known !== undefined) return known;
    let path: string;
    if (doc.location.kind === "scratch") {
      // Left behind on purpose: the file is the one the user is told to edit.
      scratchDir ??= mkdtempSync(join(tmpdir(), "todou-body-"));
      path = join(scratchDir, doc.location.name);
      writeFileSync(path, doc.text);
    } else {
      path = doc.location.path;
    }
    paths.set(doc.location, path);
    return path;
  };

  const total = blocks.length;
  const broken = failures.length;
  const headline =
    total === 1
      ? "1 mermaid diagram fails to parse — the web shows its source and this error instead of the diagram"
      : broken === 1
        ? `1 of ${total} mermaid diagrams fails to parse — the web shows its source and this error instead of the diagram`
        : `${broken} of ${total} mermaid diagrams fail to parse — the web shows their source and these errors instead of the diagrams`;
  args.note(args.paint("yellow", `warning: ${headline}`));
  for (const { doc, fence, result } of failures) {
    const line = fence.startLine + (result.line ?? 1) - 1;
    args.note(`  ${pathOf(doc)}:${line}`);
    for (const text of result.message.split("\n")) args.note(`    ${text}`);
  }

  const fix = args.fix;
  if (fix.kind === "spec") {
    args.note("  the spec is pushed; fix the diagrams and push again");
  } else {
    // A comment or an issue body is one document.
    const path = shellQuote(pathOf(failures[0].doc));
    args.note(
      fix.kind === "comment"
        ? "  the comment is posted; fix the file and update it:"
        : "  the issue is saved; fix the file and update it:",
    );
    args.note(
      fix.kind === "comment"
        ? `    todou comment edit ${fix.number} ${fix.commentId} -p ${fix.project} --body-file ${path}`
        : `    todou issue edit ${fix.number} -p ${fix.project} --body-file ${path}`,
    );
  }
  return { broken };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
