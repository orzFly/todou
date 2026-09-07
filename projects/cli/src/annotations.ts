import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import type {
  SpecAnnotationInput,
  SpecFile,
  SpecReviewCommentInput,
} from "@todou/shared";
import { SpecAnnotationsInput } from "@todou/shared";
import { z } from "zod";
import { drain } from "./body.ts";
import { CliError } from "./errors.ts";

/**
 * `spec review --annotations <file|->`: the inline half of a review, from
 * the command line (T-277). Same shape as `--questions` down to the
 * failure mode — strict schema, validated before any network round trip,
 * unknown fields rejected with their path named.
 */
export async function readAnnotationsInput(
  source: string,
  stdin: Readable,
): Promise<SpecAnnotationInput[]> {
  const raw = source === "-" ? await drain(stdin) : readAnnotationsFile(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CliError(
      `--annotations is not valid JSON: ${(cause as Error).message}`,
    );
  }
  const result = SpecAnnotationsInput.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      `invalid annotations:\n${z.prettifyError(result.error)}`,
      'expected a JSON array: [{"path": "design.md", "body": "…", "quote": "…"}, …] — instead of `quote`, `line_start`/`line_end` (optionally with `col_start`/`col_end`) anchor by number, and neither key anchors the whole file',
    );
  }
  return result.data;
}

function readAnnotationsFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new CliError(`cannot read ${path}: ${String(cause)}`);
  }
}

const ANCHOR_HINT =
  "`spec pull <n> <dir> --version <v>` writes the exact text the anchors " +
  "are resolved against";

/**
 * Every annotation as the wire wants it, anchored to `version`. The files
 * of that version are needed because a `quote` is located here rather than
 * server-side: a line number that slipped a paragraph is accepted in
 * silence, whereas text that does not match is caught before anything is
 * written.
 */
export function resolveAnnotations(
  entries: SpecAnnotationInput[],
  files: SpecFile[],
  version: number,
): SpecReviewCommentInput[] {
  const bodies = new Map(files.map((f) => [f.path, f.body]));
  return entries.map((entry) => {
    const body = bodies.get(entry.path);
    if (body === undefined) {
      throw new CliError(
        `${entry.path} is not part of spec v${version}`,
        `v${version} holds: ${files.map((f) => f.path).join(", ")}`,
      );
    }
    return {
      anchor: {
        path: entry.path,
        version,
        ...(entry.quote === undefined
          ? {
              ...(entry.line_start === undefined || entry.line_end === undefined
                ? {}
                : { line_start: entry.line_start, line_end: entry.line_end }),
              ...(entry.col_start === undefined || entry.col_end === undefined
                ? {}
                : { col_start: entry.col_start, col_end: entry.col_end }),
            }
          : locateQuote(entry.quote, body, entry.path, version)),
      },
      body: entry.body,
    };
  });
}

/** Anchor keys for one quote, 1-based and inclusive at both ends. */
type QuoteAnchor = {
  line_start: number;
  line_end: number;
  col_start?: number;
  col_end?: number;
};

/**
 * Where `quote` sits in `body`, as lines and columns. Matching is literal
 * and has to hit exactly once: an ambiguous anchor is worse than none,
 * because it points somewhere the reviewer never read.
 */
function locateQuote(
  quote: string,
  body: string,
  path: string,
  version: number,
): QuoteAnchor {
  // A quote ending in a newline would put the end offset at the column
  // after the last character of that line, which the server rejects
  // outright (T-169): a column is the inclusive index of a character, and
  // there is no character there. The same applies to a leading newline at
  // the other end — but the newlines are kept in the search, because they
  // may be part of what makes the quote unique; only the anchor's ends move
  // inwards past them.
  const needle = quote.replace(/\n+$/, "");
  const lead = needle.length - needle.replace(/^\n+/, "").length;
  if (needle.length - lead === 0) {
    throw new CliError(
      `an annotation on ${path} quotes nothing but newlines`,
      "quote the text being annotated, or anchor by line number instead",
    );
  }

  const first = body.indexOf(needle);
  if (first < 0) {
    throw new CliError(
      `quote not found in ${path} at v${version}: ${firstLine(needle)}`,
      ANCHOR_HINT,
    );
  }
  if (body.indexOf(needle, first + 1) >= 0) {
    let hits = 0;
    for (let at = first; at >= 0; at = body.indexOf(needle, at + 1)) hits += 1;
    throw new CliError(
      `quote matches ${hits} times in ${path} at v${version}: ${firstLine(needle)}`,
      "quote more surrounding context so the anchor is unambiguous",
    );
  }

  const start = positionOf(body, first + lead);
  const end = positionOf(body, first + needle.length - 1);
  const anchor: QuoteAnchor = { line_start: start.line, line_end: end.line };
  // A quote that covers whole lines end to end is a whole-line anchor: the
  // web then renders `L5–7` rather than a column range that says the same
  // thing in more characters.
  const endLineLength = lineLengthAt(body, end);
  if (start.column !== 1 || end.column !== endLineLength) {
    anchor.col_start = start.column;
    anchor.col_end = end.column;
  }
  return anchor;
}

/** 1-based line and column of the character at `offset`. */
function positionOf(
  body: string,
  offset: number,
): { line: number; column: number; lineStart: number } {
  let line = 1;
  let lineStart = 0;
  for (let at = body.indexOf("\n"); at >= 0 && at < offset; ) {
    line += 1;
    lineStart = at + 1;
    at = body.indexOf("\n", at + 1);
  }
  return { line, column: offset - lineStart + 1, lineStart };
}

function lineLengthAt(body: string, position: { lineStart: number }): number {
  const next = body.indexOf("\n", position.lineStart);
  return (next < 0 ? body.length : next) - position.lineStart;
}

/** Enough of a quote to recognize it in an error, on one line. */
function firstLine(quote: string): string {
  const head = quote.split("\n").find((line) => line !== "") ?? "";
  return JSON.stringify(head.length > 60 ? `${head.slice(0, 60)}…` : head);
}
