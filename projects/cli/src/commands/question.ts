import type {
  AnswersSubmitInput,
  IssueQuestionsItem,
  QuestionAnswer,
  TimelineItem,
  TodouClient,
  UserRef,
} from "@todou/shared";
import {
  AnswersSubmitInput as AnswersSubmitInputSchema,
  formatRef,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { z } from "zod";
import { ProjectCommand } from "../api-command.ts";
import { drain } from "../body.ts";
import { CliError } from "../errors.ts";
import {
  makePainter,
  type Painter,
  personName,
  relativeTime,
} from "../format.ts";
import { parsePositiveInt, parseSeconds } from "../parse.ts";
import {
  decodeAnswerEvent,
  renderAnswerRecords,
  renderQuestions,
} from "../questions.ts";
import { fetchRefPrefix } from "../resolve.ts";
import {
  retryTransient,
  runWatchLoop,
  watchRetryOptions,
} from "../watch-loop.ts";
import { drainTimeline } from "./issue.ts";

/** The wait/answer output once a comment's questions are resolved. */
type AnswerResult = {
  comment_id: number;
  event_id: number;
  actor: UserRef;
  created_at: string;
  answers: QuestionAnswer[];
};

function renderAnswerResult(result: AnswerResult, paint: Painter): string {
  return [
    `${paint("cyan", personName(result.actor))} answered comment ${result.comment_id} ${relativeTime(result.created_at)}:`,
    ...renderAnswerRecords(result.answers, paint),
  ].join("\n");
}

async function findQuestionComment(
  client: TodouClient,
  project: string,
  number: number,
  commentId: number,
): Promise<IssueQuestionsItem> {
  const status = await client.getIssueQuestions(project, number);
  const item = status.items.find((i) => i.comment_id === commentId);
  if (!item) {
    // "issue N", not the project's ref spelling: a failure path should not
    // spend a round trip on the reference config just to phrase itself.
    throw new CliError(
      `comment ${commentId} on issue ${number} carries no questions`,
      `list question comments with \`todou question list ${number}\``,
    );
  }
  return item;
}

export class QuestionListCommand extends ProjectCommand {
  static paths = [["question", "list"]];
  static usage = Command.Usage({
    description: "List an issue's question comments and their answer status",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL. " +
      "Questions arrive as comments carrying a questions component " +
      "(`todou comment add --questions`); this shows each with its answers.",
  });

  number = Option.String({ required: true });
  unanswered = Option.Boolean("--unanswered", false, {
    description: "Only comments still awaiting an answer",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const status = await client.getIssueQuestions(project, number);
    const items = this.unanswered
      ? status.items.filter((i) => i.answer === null)
      : status.items;
    const paint = makePainter(this.context.stdout, this.context.env);

    this.output({ items, open: status.open }, () => {
      if (items.length === 0) {
        return this.unanswered
          ? "no unanswered questions"
          : "no question comments";
      }
      const lines: string[] = [];
      for (const item of items) {
        const state = item.answer
          ? paint(
              "green",
              `answered by ${personName(item.answer.actor)} ${relativeTime(item.answer.created_at)}`,
            )
          : paint("yellow", "awaiting answer");
        lines.push(
          `${paint("bold", `comment ${item.comment_id}`)} · ${personName(item.author)} ${relativeTime(item.created_at)} · ${state}`,
        );
        lines.push(
          ...renderQuestions(
            { type: "questions", questions: item.questions },
            paint,
          ),
        );
        if (item.answer) {
          lines.push(...renderAnswerRecords(item.answer.answers, paint));
        }
      }
      return lines.join("\n");
    });
  }
}

export class QuestionWaitCommand extends ProjectCommand {
  static paths = [["question", "wait"]];
  static usage = Command.Usage({
    description: "Block until a question comment's answers arrive",
    details: `
      Waits for the \`question_answered\` event of one comment (answers are
      atomic and comment-level: every question of the comment resolves at
      once, exactly once). Already-answered comments return immediately.

      Exit codes follow \`issue watch\`: 0 = answers delivered (printed,
      decoded, as JSON under \`--json\`), 3 = timeout with no answer,
      1 = error, 4 = gave up on a network outage after automatic retries
      (rerun the same command; nothing is lost).
    `,
    examples: [
      [
        "Ask, then block on the reply",
        'ID=$(todou comment add 19 --body "…" --questions q.json --json | jq .id)\n      todou question wait 19 "$ID" --timeout 600',
      ],
    ],
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  timeout = Option.String("--timeout", {
    description: "Give up after this many seconds (default 60)",
  });
  interval = Option.String("--interval", {
    description: "Seconds between server polls (default 2)",
  });
  poll = Option.Boolean("--poll", false, {
    description: "Check once and exit instead of blocking",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = this.resolveIssueRef(this.number);
    const commentId = parsePositiveInt(this.commentId, "comment id");
    const retry = watchRetryOptions(
      this.poll,
      (line) => this.note(line),
      this.clock,
    );
    const timeoutSec =
      this.timeout === undefined ? 60 : parseSeconds(this.timeout, "--timeout");
    const intervalSec =
      this.interval === undefined
        ? 2
        : parseSeconds(this.interval, "--interval");
    const paint = makePainter(this.context.stdout, this.context.env);

    // Baseline first, answered-check second: an answer landing in between
    // is seen by the check; one landing after it lies beyond the cursor and
    // is caught by the loop. No gap either way.
    const baseline =
      (
        await retryTransient(
          () => client.getTimeline(project, number, { last: true, limit: 1 }),
          retry,
        )
      ).next_cursor ?? undefined;
    const item = await retryTransient(
      () => findQuestionComment(client, project, number, commentId),
      retry,
    );
    if (item.answer) {
      const result: AnswerResult = {
        comment_id: commentId,
        event_id: item.answer.event_id,
        actor: item.answer.actor,
        created_at: item.answer.created_at,
        answers: item.answer.answers,
      };
      this.output(result, () => renderAnswerResult(result, paint));
      return 0;
    }

    return runWatchLoop<AnswerResult>({
      poll: this.poll,
      timeoutSec,
      intervalSec,
      baseline,
      retry,
      clock: this.clock,
      drain: async (after) => {
        const page = await drainTimeline(client, project, number, {
          after,
          types: "question_answered",
        });
        const items = page.items.flatMap((entry: TimelineItem) => {
          if (entry.type !== "event") return [];
          const payload = decodeAnswerEvent(entry);
          if (payload === null || payload.comment_id !== commentId) return [];
          return [
            {
              comment_id: commentId,
              event_id: entry.id,
              actor: entry.actor,
              created_at: entry.created_at,
              answers: payload.answers,
            },
          ];
        });
        return { items, cursor: page.cursor };
      },
      onItems: (items) => {
        const result = items[0] as AnswerResult;
        this.output(result, () => renderAnswerResult(result, paint));
      },
      onEmpty: () =>
        this.output({ comment_id: commentId, answer: null }, () =>
          this.poll
            ? "not answered yet"
            : `no answer within ${timeoutSec}s (comment ${commentId} on issue ${number})`,
        ),
    });
  }
}

export class QuestionAnswerCommand extends ProjectCommand {
  static paths = [["question", "answer"]];
  static usage = Command.Usage({
    description: "Answer a question comment (all questions at once, final)",
    details: `
      Every question of the comment is answered in one atomic submission
      and answers cannot be changed afterwards. \`--answers\` takes a JSON
      array of \`{key, selected, other, declined}\` (selected = 0-based
      option indexes). For a single-question comment the flags are enough:
      \`--select\` takes an option label or 1-based position and repeats
      for multi-select; \`--decline\` refuses to answer (mutually exclusive
      with \`--select\`); \`--other\` adds free text to either.
    `,
    examples: [
      [
        "Pick option 2 and add a thought",
        'todou question answer 19 231 --select 2 --other "and ship it behind a flag"',
      ],
      [
        "Answer a multi-question comment",
        'todou question answer 19 231 --answers \'[{"key":"q1","selected":[0]},{"key":"q2","declined":true}]\'',
      ],
    ],
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  answersInput = Option.String("--answers", {
    description: "Answers as JSON (array), a file path, or - for stdin",
  });
  select = Option.Array("--select", [], {
    description: "Option label or 1-based position (repeatable)",
  });
  other = Option.String("--other", {
    description: "Free text alongside selections or a decline",
  });
  decline = Option.Boolean("--decline", false, {
    description: "Decline to answer (excludes --select)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const commentId = parsePositiveInt(this.commentId, "comment id");
    const input =
      this.answersInput === undefined
        ? await this.buildFromFlags(client, project, number, commentId)
        : await this.parseAnswersInput(this.answersInput);
    await client.submitAnswers(project, number, commentId, input);
    const item = await client
      .getIssueQuestions(project, number)
      .then((s) => s.items.find((i) => i.comment_id === commentId) ?? null);
    // Only the prose spells the issue; the JSON payload is the question
    // item, which carries no issue number to spell.
    const refPrefix = this.json ? null : await fetchRefPrefix(client, project);
    this.output(
      item,
      () => `answered comment ${commentId} on ${formatRef(refPrefix, number)}`,
    );
  }

  /** JSON from an inline string, a file, or stdin — strictly validated. */
  private async parseAnswersInput(source: string): Promise<AnswersSubmitInput> {
    let raw: string;
    if (source === "-") {
      raw = await drain(this.context.stdin);
    } else if (source.trimStart().startsWith("[")) {
      raw = source;
    } else {
      const { readFileSync } = await import("node:fs");
      try {
        raw = readFileSync(source, "utf8");
      } catch (cause) {
        throw new CliError(`cannot read ${source}: ${String(cause)}`);
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new CliError(
        `--answers is not valid JSON: ${(cause as Error).message}`,
      );
    }
    const result = AnswersSubmitInputSchema.safeParse({ answers: parsed });
    if (!result.success) {
      throw new CliError(
        `invalid answers:\n${z.prettifyError(result.error)}`,
        'expected a JSON array: [{"key": "…", "selected": [0], "other": "…", "declined": false}, …]',
      );
    }
    return result.data;
  }

  /** The single-question sugar path: resolve labels/positions to indexes. */
  private async buildFromFlags(
    client: TodouClient,
    project: string,
    number: number,
    commentId: number,
  ): Promise<AnswersSubmitInput> {
    if (this.select.length === 0 && this.other === undefined && !this.decline) {
      throw new CliError(
        "nothing to submit",
        "pass --select/--other/--decline, or --answers <json|file|->",
      );
    }
    const item = await findQuestionComment(client, project, number, commentId);
    const question = item.questions[0];
    if (item.questions.length !== 1 || question === undefined) {
      throw new CliError(
        `comment ${commentId} has ${item.questions.length} questions — flags only cover one`,
        "submit them together with --answers",
      );
    }
    const selected = this.select.map((raw) => {
      if (/^\d+$/.test(raw)) {
        const position = Number(raw);
        if (position < 1 || position > question.options.length) {
          throw new CliError(
            `--select ${raw} is out of range (1-${question.options.length})`,
          );
        }
        return position - 1;
      }
      const index = question.options.findIndex((o) => o.label === raw);
      if (index === -1) {
        throw new CliError(
          `no option labeled "${raw}"`,
          `options: ${question.options.map((o, i) => `${i + 1}) ${o.label}`).join("  ")} — numbers select by position`,
        );
      }
      return index;
    });
    return {
      answers: [
        {
          key: question.key,
          selected,
          ...(this.other === undefined ? {} : { other: this.other }),
          declined: this.decline,
        },
      ],
    };
  }
}
