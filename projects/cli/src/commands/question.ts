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
  QuestionWithdrawInput,
} from "@todou/shared";
import { Command, Option } from "clipanion";
import { z } from "zod";
import { ProjectCommand } from "../api-command.ts";
import { drain } from "../body.ts";
import { openChangeNudges } from "../change-nudges.ts";
import { CliError } from "../errors.ts";
import {
  makePainter,
  type Painter,
  personName,
  relativeTime,
} from "../format.ts";
import { parseCommentId, parseSeconds } from "../parse.ts";
import {
  decodeAnswerEvent,
  decodeWithdrawalEvent,
  renderAnswerRecords,
  renderQuestions,
  withdrawalOf,
} from "../questions.ts";
import { fetchRefPrefix } from "../resolve.ts";
import { commentRef, drainTimeline } from "../timeline.ts";
import {
  quietNote,
  retryTransient,
  runWatchLoop,
  watchMode,
  watchRetryOptions,
  watchTimeoutSec,
} from "../watch-loop.ts";

/**
 * The wait's output once a comment's questions are settled: answered, or
 * withdrawn by the asker. Both exit 0, so `kind` is what a script branches on.
 */
type SettledResult =
  | {
      kind: "answered";
      comment_id: number;
      event_id: number;
      actor: UserRef;
      created_at: string;
      answers: QuestionAnswer[];
    }
  | {
      kind: "withdrawn";
      comment_id: number;
      event_id: number;
      actor: UserRef;
      created_at: string;
      reason: string | null;
    };

function renderSettledResult(result: SettledResult, paint: Painter): string {
  const head = `${paint("cyan", personName(result.actor))} ${result.kind === "answered" ? "answered" : "withdrew"} ${commentRef(result.comment_id)} ${relativeTime(result.created_at)}`;
  if (result.kind === "withdrawn") {
    return result.reason === null ? head : `${head} — ${result.reason}`;
  }
  return [`${head}:`, ...renderAnswerRecords(result.answers, paint)].join("\n");
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
      `${commentRef(commentId)} on issue ${number} carries no questions`,
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
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const status = await client.getIssueQuestions(project, number);
    const items = this.unanswered
      ? status.items.filter(
          (i) => i.answer === null && withdrawalOf(i) === null,
        )
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
        const withdrawal = withdrawalOf(item);
        const state = item.answer
          ? paint(
              "green",
              `answered by ${personName(item.answer.actor)} ${relativeTime(item.answer.created_at)}`,
            )
          : withdrawal
            ? paint(
                "dim",
                `withdrawn by ${personName(withdrawal.actor)} ${relativeTime(withdrawal.created_at)}`,
              )
            : paint("yellow", "awaiting answer");
        lines.push(
          `${paint("bold", commentRef(item.comment_id))} · ${personName(item.author)} ${relativeTime(item.created_at)} · ${state}`,
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
        if (withdrawal?.reason != null) {
          lines.push(`  reason: ${withdrawal.reason.split("\n").join("\n  ")}`);
        }
      }
      return lines.join("\n");
    });
  }
}

export class QuestionWaitCommand extends ProjectCommand {
  static paths = [["question", "wait"]];
  static usage = Command.Usage({
    description:
      "Block until a question comment's answers arrive, or its withdrawal",
    details: `
      Waits for the \`question_answered\` event of one comment (answers are
      atomic and comment-level: every question of the comment resolves at
      once, exactly once), or for its \`question_withdrawn\` event when the
      questions are withdrawn instead. Already-settled comments return
      immediately.

      Exit codes follow \`issue watch\`: 0 = the questions were answered or
      withdrawn (printed, decoded, as JSON under \`--json\`, where \`kind\`
      is \`answered\` or \`withdrawn\`), or a \`--poll\` finished its one
      check, settled or not; 3 = a blocking wait timed out with no answer;
      1 = error; 4 = gave up on a network outage after automatic retries
      (rerun the same command; nothing is lost).

      \`--forever\` makes the wait one trustworthy call, with no re-run loop
      around it: it never exits on a timeout and never gives up on an
      outage, so it returns only with the answers or the withdrawal (0) or a
      fatal error (1) — the shape a question that may sit unread for hours
      actually needs.
      \`--timeout\` then means the heartbeat interval (default 600s): one
      \`still waiting for an answer — nothing new in …\` line to stderr per
      elapsed interval. Conflicts with \`--poll\`.
    `,
    examples: [
      [
        "Ask, then block on the reply",
        'ID=$(todou comment add 19 --body "…" --json --questions <(cat <<\'EOF\'\n[…]\nEOF\n) | jq .id)\ntodou question wait 19 "$ID" --timeout 600',
      ],
      [
        "Block until answered, however long that takes",
        'todou question wait 19 "$ID" --forever',
      ],
    ],
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  timeout = Option.String("--timeout", {
    description:
      "Give up after this many seconds (default 60; with --forever, seconds between heartbeats, default 600)",
  });
  interval = Option.String("--interval", {
    description: "Seconds between server polls (default 2)",
  });
  invisible = Option.Boolean("--invisible", false, {
    description: "Do not show this watch to others as a live watcher",
  });
  poll = Option.Boolean("--poll", false, {
    description: "Check once and exit instead of blocking",
  });
  forever = Option.Boolean("--forever", false, {
    description:
      "Wait until the answers or the withdrawal arrive, or a fatal error — never time out, retry outages indefinitely (conflicts with --poll)",
  });

  protected async run(client: TodouClient): Promise<number> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const commentId = parseCommentId(this.commentId);
    const mode = watchMode(this.poll, this.forever);
    const retry = watchRetryOptions(
      mode,
      (line) => this.note(line),
      this.clock,
    );
    const timeoutSec = watchTimeoutSec(this.timeout, mode);
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
    const withdrawal = withdrawalOf(item);
    const settled: SettledResult | null = item.answer
      ? {
          kind: "answered",
          comment_id: commentId,
          event_id: item.answer.event_id,
          actor: item.answer.actor,
          created_at: item.answer.created_at,
          answers: item.answer.answers,
        }
      : withdrawal
        ? {
            kind: "withdrawn",
            comment_id: commentId,
            event_id: withdrawal.event_id,
            actor: withdrawal.actor,
            created_at: withdrawal.created_at,
            reason: withdrawal.reason,
          }
        : null;
    if (settled !== null) {
      this.output(settled, () => renderSettledResult(settled, paint));
      return 0;
    }

    // Transport, not truth (T-123): the answer still comes from draining the
    // timeline at `baseline`, the feed only decides when to drain. A wait
    // that may sit for hours has no business idling on a poll interval when
    // the server can say the moment something lands (T-208).
    const nudges = this.poll
      ? null
      : await openChangeNudges({
          client,
          projects: new Set([project]),
          issue: number,
          intervalSec,
          clock: this.clock,
          declare: this.invisible ? undefined : { kind: "question_wait" },
          context: () => this.liveAgentContext(),
        });
    try {
      return await runWatchLoop<SettledResult>({
        ...mode,
        timeoutSec,
        intervalSec,
        baseline,
        retry,
        clock: this.clock,
        wait: nudges?.wait,
        onQuiet: (_cursor, totalMs) =>
          this.note(
            quietNote("still waiting for an answer", timeoutSec, totalMs),
          ),
        // No `types` filter: a server predating withdrawals refuses
        // `question_withdrawn` there with a 422, which would end even a
        // `--forever` wait at its first drain. The settling events are picked
        // out here instead.
        drain: async (after) => {
          const page = await drainTimeline(client, project, number, { after });
          const items = page.items.flatMap(
            (entry: TimelineItem): SettledResult[] => {
              if (entry.type !== "event") return [];
              const event = {
                comment_id: commentId,
                event_id: entry.id,
                actor: entry.actor,
                created_at: entry.created_at,
              };
              const answered = decodeAnswerEvent(entry);
              if (answered?.comment_id === commentId) {
                return [
                  { kind: "answered", ...event, answers: answered.answers },
                ];
              }
              const withdrawn = decodeWithdrawalEvent(entry);
              if (withdrawn?.comment_id === commentId) {
                return [
                  { kind: "withdrawn", ...event, reason: withdrawn.reason },
                ];
              }
              return [];
            },
          );
          return { items, cursor: page.cursor };
        },
        onItems: (items) => {
          const result = items[0] as SettledResult;
          this.output(result, () => renderSettledResult(result, paint));
        },
        onEmpty: () =>
          this.output({ comment_id: commentId, answer: null }, () =>
            this.poll
              ? "not answered yet"
              : `no answer within ${timeoutSec}s (${commentRef(commentId)} on issue ${number})`,
          ),
      });
    } finally {
      nudges?.close();
    }
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
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const commentId = parseCommentId(this.commentId);
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
      () =>
        `answered ${commentRef(commentId)} on ${formatRef(refPrefix, number)}`,
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
        `${commentRef(commentId)} has ${item.questions.length} questions — flags only cover one`,
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

export class QuestionWithdrawCommand extends ProjectCommand {
  static paths = [["question", "withdraw"]];
  static usage = Command.Usage({
    description: "Withdraw a question comment nobody has answered yet",
    details: `
      For questions that no longer need an answer. Only an unanswered
      comment can be withdrawn, and withdrawing is final: the comment and
      its questions stay readable, but they take no answer afterwards. Ask
      again in a new comment if part of it still matters. A
      \`question wait\` on the comment returns with the withdrawal.

      \`--reason\` is optional plain text, trimmed to 1–2000 characters when
      supplied; it sends no mention notifications. Retrying an already
      withdrawn comment succeeds unchanged and returns the original cursor,
      without saving the new reason.

      The last output line is the withdrawal cursor. \`--json\` prints
      \`comment_id\`, \`unchanged\` and \`cursor\`; the cursor always
      identifies the original withdrawal event.
    `,
    examples: [
      [
        "Withdraw a question the code already answered",
        '$0 question withdraw 19 231 --reason "answered by the code"',
      ],
    ],
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  reason = Option.String("--reason", {
    description:
      "Optional plain-text reason (1–2000 characters after trimming)",
  });

  protected async run(client: TodouClient): Promise<void> {
    const commentId = parseCommentId(this.commentId);
    const input = QuestionWithdrawInput.safeParse(
      this.reason === undefined ? {} : { reason: this.reason },
    );
    if (!input.success) {
      throw new CliError(
        `invalid question withdraw (--reason):\n${z.prettifyError(input.error)}`,
      );
    }
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const result = await client.withdrawQuestions(
      project,
      number,
      commentId,
      input.data,
    );
    const refPrefix =
      this.json || result.unchanged
        ? null
        : await fetchRefPrefix(client, project);
    this.output(result, () => {
      const summary = result.unchanged
        ? `${commentRef(commentId)} already withdrawn (unchanged)`
        : `withdrew ${commentRef(commentId)} on ${formatRef(refPrefix, number)}`;
      return `${summary}\ncursor: ${result.cursor} (issue watch --since <cursor>)`;
    });
  }
}
