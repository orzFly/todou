import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Attachment, TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";

export class AttachCommand extends ProjectCommand {
  static paths = [["attach"]];
  static usage = Command.Usage({
    description: "Upload files as attachments on an issue",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL.",
  });

  number = Option.String({ required: true });
  files = Option.Rest({ required: 1 });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = this.resolveIssueRef(this.number);
    const uploaded: Attachment[] = [];
    for (const path of this.files) {
      let blob: Blob;
      try {
        blob = await openAsBlob(path);
      } catch (cause) {
        throw new CliError(`cannot read ${path}: ${String(cause)}`);
      }
      const file = new File([blob], basename(path), { type: blob.type });
      uploaded.push(await client.uploadAttachment(project, number, file));
      this.note(`uploaded ${basename(path)}`);
    }
    this.output(uploaded, () =>
      uploaded.map((a) => `${a.filename} → ${a.url}`).join("\n"),
    );
  }
}
