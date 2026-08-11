import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CliError } from "./errors.ts";

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Issue/comment body from, in order: --body, --body-file (- = stdin), or —
 * only on a TTY — $EDITOR on a scratch file. Agents never reach the editor:
 * without a TTY the command fails fast instead of hanging on user input.
 */
export async function readBody(options: {
  body?: string;
  bodyFile?: string;
  stdin: Readable;
  isTTY: boolean;
  env: Record<string, string | undefined>;
}): Promise<string> {
  if (options.body !== undefined) return options.body;
  if (options.bodyFile === "-") return drain(options.stdin);
  if (options.bodyFile !== undefined) {
    try {
      return readFileSync(options.bodyFile, "utf8");
    } catch (cause) {
      throw new CliError(`cannot read ${options.bodyFile}: ${String(cause)}`);
    }
  }
  if (!options.isTTY) {
    throw new CliError(
      "no body given",
      "pass --body <text> or --body-file <path|->",
    );
  }
  return editBody(options.env);
}

function editBody(env: Record<string, string | undefined>): string {
  const editor = env.EDITOR || env.VISUAL || "vi";
  const dir = mkdtempSync(join(tmpdir(), "todou-body-"));
  const file = join(dir, "BODY.md");
  try {
    writeFileSync(file, "");
    const result = spawnSync(editor, [file], { stdio: "inherit", shell: true });
    if (result.error || result.status !== 0) {
      throw new CliError(`editor ${editor} failed`);
    }
    const body = readFileSync(file, "utf8");
    if (body.trim() === "") {
      throw new CliError("aborted: empty body");
    }
    return body;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
