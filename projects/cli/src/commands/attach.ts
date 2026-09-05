import { createWriteStream, existsSync, openAsBlob, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Attachment, TodouClient } from "@todou/shared";
import { Command, Option } from "clipanion";
import { ProjectCommand } from "../api-command.ts";
import { CliError } from "../errors.ts";
import { formatBytes, table } from "../format.ts";

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
  // `attach add` is what six of the sessions in the T-165 survey reached for
  // before finding the bare form; both spellings upload.
  static paths = [["attach"], ["attach", "add"]];
  static usage = Command.Usage({
    description: "Upload files as attachments on an issue",
    details:
      "`<number>` also accepts `<project>/<number>` or a full issue URL. " +
      "See `attach list` for what an issue already carries and " +
      "`attach download` for getting it back.",
  });

  number = Option.String({ required: true });
  files = Option.Rest({ required: 1 });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
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
      const stored = await client.uploadAttachment(project, number, file);
      uploaded.push(stored);
      // Filenames are unique within a card, so the server may have appended
      // an id (T-269). Say so when it did: the markdown someone writes next
      // has to use the stored name, not the one on their disk.
      this.note(
        stored.filename === basename(path)
          ? `uploaded ${basename(path)}`
          : `uploaded ${basename(path)} as ${stored.filename}`,
      );
    }
    this.output(uploaded, () =>
      // `#id` first, the shape `attach list` prints and `attach download`
      // addresses — an upload otherwise had no way to name what it made.
      uploaded.map((a) => `#${a.id} ${a.filename} → ${a.url}`).join("\n"),
    );
  }
}

export class AttachListCommand extends ProjectCommand {
  static paths = [["attach", "list"]];
  static usage = Command.Usage({
    description: "List the attachments on an issue",
    details:
      "The authoritative view of what an issue carries: the timeline only " +
      "records upload *events*, and a body only links what someone chose to " +
      "link. `--json` prints the raw array of attachment objects. The `#id` " +
      "column is what `attach download` addresses.",
    examples: [["List what is attached to issue 16", "$0 attach list 16"]],
  });

  number = Option.String({ required: true });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    const attachments = await client.listAttachments(project, number);
    this.output(attachments, () =>
      attachments.length === 0
        ? "no attachments"
        : table(
            attachments.map((a) => [
              `#${a.id}`,
              a.filename,
              formatBytes(a.size),
              a.url,
            ]),
          ),
    );
  }
}

/**
 * A digits-only argument is an id first and a filename second, so an
 * attachment literally named "42" stays reachable once no id matches.
 *
 * Names are matched with the server's own yardstick — NFC, case folded —
 * which is what `attachments_issue_filename_idx` enforces, so a name typed
 * in the wrong case still finds its file.
 */
function selectAttachment(list: Attachment[], key: string): Attachment {
  if (/^\d+$/.test(key)) {
    const byId = list.find((a) => a.id === Number(key));
    if (byId !== undefined) return byId;
  }
  const fold = (name: string) => name.normalize("NFC").toLowerCase();
  const named = list.filter((a) => fold(a.filename) === fold(key));
  const first = named[0];
  if (named.length === 1 && first !== undefined) return first;
  if (named.length > 1) {
    // Unreachable since T-269 made filenames unique within a card; kept as
    // the backstop for a server that predates the index, where guessing
    // would write the wrong bytes.
    throw new CliError(
      `${named.length} attachments are named "${key}":\n${table(
        named.map((a) => [`#${a.id}`, formatBytes(a.size), a.created_at]),
      )}`,
      "address the one you want by id",
    );
  }
  throw new CliError(
    `no attachment "${key}" on this issue`,
    list.length === 0
      ? "the issue has no attachments"
      : `attached: ${list.map((a) => `#${a.id} ${a.filename}`).join(", ")}`,
  );
}

export class AttachDownloadCommand extends ProjectCommand {
  static paths = [["attach", "download"]];
  static usage = Command.Usage({
    description: "Download an attachment, reusing the stored login",
    details:
      "Authenticates the same way every other command does, so there is " +
      "never a reason to read a token out of the config file and hand-write " +
      "a request. Permissions are the server's usual ones: whoever can read " +
      "the issue can download its files.\n\n" +
      "`<id-or-name>` is an id from `attach list` or a filename; filenames " +
      "are unique within an issue, so a name is never ambiguous, and the " +
      "match ignores case. Without `-o` the file lands in the current " +
      "directory under its own name and an existing file is never " +
      "overwritten. `-o <dir>` writes " +
      "into that directory under the same rule, `-o <file>` writes exactly " +
      "there and may overwrite, and `-o -` streams the bytes to stdout.",
    examples: [
      ["Download by id", "$0 attach download 16 42"],
      [
        "Download by name into a directory",
        "$0 attach download 16 shot.png -o ./downloads",
      ],
      [
        "Pipe an attachment onward",
        "$0 attach download 16 shot.png -o - | wc -c",
      ],
    ],
  });

  number = Option.String({ required: true });
  target = Option.String({ required: true });
  destination = Option.String("-o,--output", {
    description: "Destination file, directory, or - for stdout",
  });

  protected async run(client: TodouClient): Promise<void> {
    const { project, number } = await this.resolveIssueRef(client, this.number);
    if (this.destination === "-" && this.json) {
      throw new CliError(
        "-o - and --json both want stdout",
        "drop one — the bytes and the metadata cannot share the stream",
      );
    }

    const attachment = selectAttachment(
      await client.listAttachments(project, number),
      this.target,
    );
    const path = this.destination === "-" ? null : this.pathFor(attachment);

    const res = await client.requestRaw(
      "GET",
      `/projects/${project}/attachments/${attachment.id}/download`,
    );
    const bytes =
      res.body === null
        ? Readable.from([])
        : Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    const summary = `${attachment.filename} (${formatBytes(attachment.size)})`;

    if (path === null) {
      // `end: false`: stdout belongs to the process, not to this pipeline.
      await pipeline(bytes, this.context.stdout, { end: false });
      this.note(summary);
      return;
    }
    await pipeline(bytes, createWriteStream(path));
    this.output(
      { ...attachment, saved_to: path },
      () => `${summary} → ${path}`,
    );
  }

  private pathFor(attachment: Attachment): string {
    // basename() over a name the server already sanitized: one stale server
    // must not be enough to write outside the directory the user picked.
    const filename = basename(attachment.filename);
    if (this.destination === undefined) {
      return this.unoccupied(resolve(this.context.cwd, filename));
    }
    const given = resolve(this.context.cwd, this.destination);
    if (existsSync(given) && statSync(given).isDirectory()) {
      return this.unoccupied(join(given, filename));
    }
    // A path the user typed is a target they chose, so it may be
    // overwritten; only the paths we derived for them are protected.
    return given;
  }

  private unoccupied(path: string): string {
    if (existsSync(path)) {
      throw new CliError(
        `${path} already exists`,
        "pass -o <path> to write somewhere else",
      );
    }
    return path;
  }
}
