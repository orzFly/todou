// The sub-bundle's entry, and the module the source loader imports. Nothing
// else in the CLI may import it: that would pull mermaid into the main bundle.
import mermaid from "mermaid";
import type { DiagramResult } from "./types.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The 1-based line within the diagram an error points at. jison grammars
 * (flowchart, sequence, …) carry it structurally; langium grammars (pie,
 * architecture, …) only say it in the message.
 */
function errorLine(error: unknown): number | null {
  const first = (error as { hash?: { loc?: { first_line?: unknown } } })?.hash
    ?.loc?.first_line;
  if (typeof first === "number") return first;
  const match = /line (\d+), column \d+/.exec(errorMessage(error));
  return match === null ? null : Number(match[1]);
}

export async function parseAll(sources: string[]): Promise<DiagramResult[]> {
  const results: DiagramResult[] = [];
  for (const source of sources) {
    try {
      await mermaid.parse(source);
      results.push({ ok: true });
    } catch (error) {
      results.push({
        ok: false,
        message: errorMessage(error),
        line: errorLine(error),
      });
    }
  }
  return results;
}
