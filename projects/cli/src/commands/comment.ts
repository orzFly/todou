import type { TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { makePainter } from "../format.ts";
import { parsePositiveInt } from "../parse.ts";
import { readQuestionsInput } from "../questions.ts";
import { withIssueRef } from "../refs.ts";
import { fetchRefPrefix } from "../resolve.ts";
import {
  assertWriteCursorFlags,
  collectWriteCursor,
  emitWriteResult,
} from "../write-cursor.ts";

export class CommentAddCommand extends ProjectCommand {
  static paths = [
    ["comment", "add"],
    ["issue", "comment"],
  ];
  static usage = Command.Usage({
    description: "Comment on an issue, optionally asking questions",
    details: `
      \`<number>\` also accepts \`<project>/<number>\` or a full issue URL;
      \`issue comment\` is an alias of \`comment add\`.

      \`--questions\` attaches a questions component (T-19): a JSON array of
      \`{question, options: [{label, description?}], multiple?, key?,
      header?}\`, all text fields markdown. Validation is strict — unknown
      fields fail with their path named. Readers answer on the issue page
      (or \`todou question answer\`); block on the reply with
      \`todou question wait <issue> <commentId>\`.

      At most one of \`--body-file\`/\`--questions\` may be \`-\` — stdin is a
      single stream; process substitution (\`<(…)\`) covers the pair.

      The new comment answers with the cursor to wait for a reply from:
      every timeline entry created after it is delivered by
      \`issue watch --since <cursor>\` (and \`question wait\` needs no
      cursor at all — it checks the answer state before it blocks). It is
      printed as the last line, sits in \`--json\` as \`cursor\`, and
      \`--print-cursor\` puts it alone on stdout with the summary moved to
      stderr, for \`cursor=$(todou comment add …  --print-cursor)\`. A
      cursor taken *after* the write instead leaves a window in which the
      answer being waited for can land unseen.

      \`--since <cursor>\` says where the writer last looked. The comment
      is posted regardless; afterwards the entries between that cursor and
      now — other people's only, as watches count them — are listed on
      stderr (or as \`missed\` under \`--json\`), and the reported cursor is
      the given one echoed back, so anything shown here is delivered again
      by a watch resuming from it. \`--print-cursor\` conflicts with
      \`--json\`; both want stdout.
    `,
    examples: [
      [
        "Ask a question alongside the comment body, one call (bash/zsh)",
        // Continuations sit at column 0 on purpose: an indented heredoc
        // terminator does not terminate, so anything else fails when pasted.
        "todou comment add 19 --json --body-file <(cat <<'EOF'\n…context…\nEOF\n) --questions <(cat <<'EOF2'\n[…]\nEOF2\n)",
      ],
      [
        "Comment, then watch for the reply with no gap in between",
        'cursor=$(todou comment add 19 --body "ping" --print-cursor) && todou issue watch 19 --since "$cursor" --forever',
      ],
    ],
  });

  number = Option.String({ required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });
  questions = Option.String("--questions", {
    description: "Questions as a JSON array from a file, or - for stdin",
  });
  printCursor = Option.Boolean("--print-cursor", false, {
    description:
      "Print the waiting-start cursor alone on stdout, summary to stderr",
  });
  since = Option.String("--since", {
    description:
      "Report what landed since this cursor (echoed back as the cursor)",
  });

  protected async run(client: TodouClient): Promise<void> {
    assertWriteCursorFlags(this);
    const { project, number } = this.resolveIssueRef(this.number);
    if (this.bodyFile === "-" && this.questions === "-") {
      throw new CliError("--body-file and --questions cannot both read stdin");
    }
    const body = await readBody({
      body: this.body,
      bodyFile: this.bodyFile,
      stdin: this.context.stdin,
      isTTY: Boolean((this.context.stdin as { isTTY?: boolean }).isTTY),
      env: this.context.env,
    });
    const component =
      this.questions === undefined
        ? undefined
        : await readQuestionsInput(this.questions, this.context.stdin);
    const comment = await client.createComment(
      project,
      number,
      body,
      component,
    );
    const refPrefix = await fetchRefPrefix(client, project);
    const posted = withIssueRef(
      { ...comment, issue_number: number },
      refPrefix,
    );
    const outcome = await collectWriteCursor({
      client,
      project,
      number,
      served: comment.cursor,
      since: this.since,
      agentContext: this.agentContext,
      note: (line) => this.note(line),
      clock: this.clock,
    });
    emitWriteResult(
      {
        json: this.json,
        printCursor: this.printCursor,
        paint: makePainter(this.context.stdout, this.context.env),
        refPrefix,
        issueNumber: number,
        write: (text) => this.context.stdout.write(`${text}\n`),
        note: (line) => this.note(line),
      },
      outcome,
      posted,
      () =>
        component === undefined
          ? // The id is the permalink anchor and `comment edit`'s argument;
            // without it here the only way to learn it was a second `--json` call.
            `comment ${comment.id} on ${posted.issue_ref} (#comment-${comment.id})`
          : `asked ${component.questions.length} question(s) on ${posted.issue_ref} — ` +
            `wait for answers with \`todou question wait ${number} ${comment.id}\``,
    );
  }
}

export class CommentEditCommand extends ProjectCommand {
  static paths = [["comment", "edit"]];
  static usage = Command.Usage({
    description: "Edit a comment's body (author or project admin)",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL.",
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const commentId = parsePositiveInt(this.commentId, "comment id");
    const body = await readBody({
      body: this.body,
      bodyFile: this.bodyFile,
      stdin: this.context.stdin,
      isTTY: Boolean((this.context.stdin as { isTTY?: boolean }).isTTY),
      env: this.context.env,
    });
    const comment = await client.updateComment(
      project,
      number,
      commentId,
      body,
    );
    const refPrefix = await fetchRefPrefix(client, project);
    const edited = withIssueRef(
      { ...comment, issue_number: number },
      refPrefix,
    );
    this.output(
      edited,
      () => `edited comment ${commentId} on ${edited.issue_ref}`,
    );
  }
}
