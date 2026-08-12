import { openAsBlob } from "node:fs";
import { basename, extname } from "node:path";
import type { Attachment, TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";

// openAsBlob never fills in a type, and the server stores whatever it gets —
// without this, every upload lands as application/octet-stream and the web
// UI cannot offer inline previews.
const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".zip": "application/zip",
};

export function mimeTypeFor(path: string): string {
  return (
    MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

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
      const file = new File([blob], basename(path), {
        type: blob.type || mimeTypeFor(path),
      });
      uploaded.push(await client.uploadAttachment(project, number, file));
      this.note(`uploaded ${basename(path)}`);
    }
    this.output(uploaded, () =>
      uploaded.map((a) => `${a.filename} → ${a.url}`).join("\n"),
    );
  }
}
