import type { TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { readBody } from "../body.ts";
import { parsePositiveInt } from "../parse.ts";

export class CommentAddCommand extends ProjectCommand {
  static paths = [["comment", "add"]];
  static usage = Command.Usage({ description: "Comment on an issue" });

  number = Option.String({ required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const number = parsePositiveInt(this.number, "issue number");
    const body = await readBody({
      body: this.body,
      bodyFile: this.bodyFile,
      stdin: this.context.stdin,
      isTTY: Boolean((this.context.stdin as { isTTY?: boolean }).isTTY),
      env: this.context.env,
    });
    const comment = await client.createComment(project, number, body);
    this.output(comment, () => `commented on #${number}`);
  }
}

export class CommentEditCommand extends ProjectCommand {
  static paths = [["comment", "edit"]];
  static usage = Command.Usage({
    description: "Edit a comment's body (author or project admin)",
  });

  number = Option.String({ required: true });
  commentId = Option.String({ required: true });
  body = Option.String("--body");
  bodyFile = Option.String("--body-file", {
    description: "Body from a file, or - for stdin",
  });

  protected async run(client: TodouClient): Promise<void> {
    const project = this.requireProject();
    const number = parsePositiveInt(this.number, "issue number");
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
    this.output(comment, () => `edited comment ${commentId} on #${number}`);
  }
}
