import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import type {
  CommentComponentInput,
  QuestionAnswer,
  QuestionsComponent,
  TimelineEvent,
} from "@todou/shared";
import { QuestionAnsweredPayload, QuestionsInput } from "@todou/shared";
import { z } from "zod";
import { drain } from "./body.ts";
import { CliError } from "./errors.ts";
import type { Painter } from "./format.ts";

/**
 * `--questions <file|->` → validated component input. The file holds the
 * bare questions array; validation is strict (unknown fields are rejected
 * with their path named) because hallucinated extras must fail loudly, and
 * it runs here — before any network round trip — so the error arrives
 * instantly and reads the same as the server's.
 */
export async function readQuestionsInput(
  source: string,
  stdin: Readable,
): Promise<CommentComponentInput> {
  const raw = source === "-" ? await drain(stdin) : readQuestionsFile(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new CliError(
      `--questions is not valid JSON: ${(cause as Error).message}`,
    );
  }
  const result = QuestionsInput.safeParse(parsed);
  if (!result.success) {
    throw new CliError(
      `invalid questions:\n${z.prettifyError(result.error)}`,
      'expected a JSON array: [{"question": "…", "options": [{"label": "…", "description": "…"}, …], "multiple": false, "key": "…", "header": "…"}, …] (key/header/multiple/description optional)',
    );
  }
  return { type: "questions", questions: result.data };
}

function readQuestionsFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    throw new CliError(`cannot read ${path}: ${String(cause)}`);
  }
}

/** Payload of a question_answered event, or null for any other event. */
export function decodeAnswerEvent(
  item: TimelineEvent,
): { comment_id: number; answers: QuestionAnswer[] } | null {
  if (item.event_type !== "question_answered") return null;
  const parsed = QuestionAnsweredPayload.safeParse(item.payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Question block for `issue view` / `question list` / a watch line, 1-based
 * numbering. `descriptions: false` is for the watch, where the question and
 * its option labels are what a reader needs to answer and the descriptions
 * would multiply the length of an entry nobody asked to read in full.
 */
export function renderQuestions(
  component: QuestionsComponent,
  paint: Painter,
  opts: { indent?: string; descriptions?: boolean } = {},
): string[] {
  const indent = opts.indent ?? "  ";
  const lines: string[] = [];
  for (const q of component.questions) {
    const mode = q.multiple ? "multi-select" : "single-select";
    const head = q.header === undefined ? "" : ` ${q.header} ·`;
    lines.push(paint("bold", `${indent}[${q.key}]${head} ${mode}`));
    for (const line of q.question.trimEnd().split("\n")) {
      lines.push(`${indent}${line}`);
    }
    q.options.forEach((option, i) => {
      const description =
        option.description === undefined || opts.descriptions === false
          ? ""
          : ` — ${option.description}`;
      lines.push(`${indent}  ${i + 1}) ${option.label}${description}`);
    });
  }
  return lines;
}

/** One line per answered question: selections, other text, or the decline. */
export function renderAnswerRecords(
  answers: QuestionAnswer[],
  paint: Painter,
  indent = "  ",
): string[] {
  return answers.map((a) => {
    const parts: string[] = [];
    if (a.declined) parts.push(paint("yellow", "declined"));
    for (const s of a.selected) parts.push(`${s.index + 1}) ${s.label}`);
    if (a.other !== null) parts.push(`other: ${JSON.stringify(a.other)}`);
    return `${indent}${paint("cyan", a.key)}: ${parts.join(" · ")}`;
  });
}
