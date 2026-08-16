import type { TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { CliError } from "../errors.ts";
import { parsePositiveInt } from "../parse.ts";
import { readQuestionsInput } from "../questions.ts";
import { withIssueRef } from "../refs.ts";
import { fetchRefPrefix } from "../resolve.ts";

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
    `,
    examples: [
      [
        "Ask a question alongside the comment body",
        "todou comment add 19 --body-file ctx.md --questions questions.json --json",
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

  protected async run(client: TodouClient): Promise<void> {
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
    this.output(posted, () =>
      component === undefined
        ? `commented on ${posted.issue_ref}`
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
