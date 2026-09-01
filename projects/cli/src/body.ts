import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { CliError } from "./errors.ts";

export async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A `--body` that is really a `--body-file` argument. `stream` cannot be
 * anything else; `file` might be, so the two are answered differently.
 */
export type BodyPathVerdict =
  | { level: "stream"; why: string }
  | { level: "file" }
  | null;

/**
 * The paths that carry a stream rather than text: `-` is `--body-file`'s own
 * spelling for stdin, and the rest are what a shell hands over for `<(…)`.
 * Matched literally and never stat'd, so the verdict cannot depend on which
 * of them a given kernel exposes — `/dev/fd/63` is the same slip whether or
 * not this process has that descriptor open.
 */
const STREAM_PATHS = [
  /^\/dev\/std(in|out|err)$/,
  /^\/dev\/fd\/\d+$/,
  /^\/proc\/(self|\d+)\/fd\/\d+$/,
];

/**
 * Whether a `--body` value is a path someone meant to pass to `--body-file`.
 *
 * The `file` level is deliberately narrower than "looks like a path": it
 * fires only where `--body-file` would have *succeeded*, so a directory or
 * an unreadable path stays silent — there `--body-file` fails loudly on its
 * own and the slip cannot go unnoticed. A body that is genuinely one
 * existing filename is rare, and it is the reason that level only warns.
 */
export function classifyBodyValue(value: string, cwd: string): BodyPathVerdict {
  if (value === "-") {
    return { level: "stream", why: "which is how --body-file spells stdin" };
  }
  if (STREAM_PATHS.some((pattern) => pattern.test(value))) {
    return { level: "stream", why: "which is a stream path, not body text" };
  }
  if (value.includes("\n")) return null;
  try {
    const path = resolve(cwd, value);
    if (!statSync(path).isFile()) return null;
    accessSync(path, constants.R_OK);
  } catch {
    return null;
  }
  return { level: "file" };
}

/**
 * Both messages lead with whether anything was written, because that is what
 * the reader has to decide first: resend, or go and delete what just landed.
 *
 * The warning can only promise that the write is not blocked, never that it
 * happened — nothing has been sent yet at this point, and for the same
 * reason it cannot name the comment id to delete. What actually landed is
 * the summary line the command prints afterwards.
 */
function guardBodyPath(
  body: string,
  cwd: string,
  note?: (line: string) => void,
): void {
  const verdict = classifyBodyValue(body, cwd);
  if (verdict === null) return;
  if (verdict.level === "stream") {
    throw new CliError(
      `--body was given ${body}, ${verdict.why}`,
      "nothing was written — use --body-file for the contents, or --allow-body-path to keep the path as the body",
    );
  }
  note?.(
    `warning: --body was given ${body}, an existing file — the body is that path, not the file's contents`,
  );
  note?.(
    "not refused, the write goes ahead — use --body-file for the contents, or --allow-body-path to silence this",
  );
}

/**
 * Issue/comment body from, in order: --body, --body-file (- = stdin), or —
 * only on a TTY — $EDITOR on a scratch file. Agents never reach the editor:
 * without a TTY the command fails fast instead of hanging on user input.
 *
 * A --body that is itself a path is guarded (T-198): the whole point of the
 * flag mixup it catches is that nothing downstream can tell the two apart,
 * so it has to be caught here, before any request goes out.
 */
export async function readBody(options: {
  body?: string;
  bodyFile?: string;
  stdin: Readable;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  cwd: string;
  allowBodyPath?: boolean;
  note?: (line: string) => void;
}): Promise<string> {
  if (options.body !== undefined) {
    if (!options.allowBodyPath) {
      guardBodyPath(options.body, options.cwd, options.note);
    }
    return options.body;
  }
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
