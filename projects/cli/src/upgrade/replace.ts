import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { CliError } from "../errors.ts";
import type { Step } from "./plan.ts";

/** The filesystem calls the swap makes, replaceable so the Windows order is testable off Windows. */
export type SwapIo = Pick<
  typeof fsp,
  "rename" | "unlink" | "readdir" | "chmod" | "stat"
>;

export class UnreplaceableError extends CliError {}

/** The bytes were not the ones the plan named: nothing was installed. */
export class VerificationError extends CliError {}

/** The source failed before any bytes could be judged. */
export class DownloadError extends CliError {}

const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR"]);

function unreplaceable(target: string, error: unknown): UnreplaceableError {
  const code = (error as { code?: string }).code ?? String(error);
  return new UnreplaceableError(
    `replacing ${target} is not supported: ${dirname(target)} is not writable (${code})`,
    "reinstall it by the means it was installed with, or rerun as a user who can write there",
  );
}

export type Reserved = { path: string; handle: fsp.FileHandle };

/**
 * The new file lives beside the old one, never in a temp directory: rename(2)
 * is only atomic within one filesystem. Creating it is also the writability
 * check — `access(W_OK)` on the target says nothing about the directory,
 * which is what a rename actually needs.
 */
export async function reserve(target: string): Promise<Reserved> {
  const ext = extname(target);
  const path = join(
    dirname(target),
    `.${basename(target)}.upgrade-${randomBytes(6).toString("hex")}${ext}`,
  );
  try {
    return { path, handle: await fsp.open(path, "wx", 0o600) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== undefined && UNWRITABLE.has(code)) {
      throw unreplaceable(target, error);
    }
    throw error;
  }
}

/**
 * Streams into the reserved file, hashing as it goes. Throws without leaving
 * anything behind but the reserved file, which the caller removes.
 */
export async function download(
  fetchImpl: typeof fetch,
  step: Step,
  handle: fsp.FileHandle,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(step.url);
  } catch (error) {
    throw new DownloadError(`cannot download ${step.url}: ${String(error)}`);
  }
  if (!res.ok || res.body === null) {
    await res.body?.cancel();
    throw new DownloadError(`cannot download ${step.url}: HTTP ${res.status}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (step.size !== undefined && size > step.size) {
        throw new VerificationError(
          `${step.url} sent more than the ${step.size} bytes its manifest declares`,
        );
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new DownloadError(
      `download of ${step.url} broke off: ${String(error)}`,
    );
  }
  const got = hash.digest("hex");
  if (got !== step.sha256) {
    throw new VerificationError(
      `${step.url} has sha256 ${got}, expected ${step.sha256} — not installed`,
    );
  }
}

/**
 * Runs the new file once before it replaces anything: a sha256 proves the
 * bytes, not that they start on this machine (T-204 shipped executables that
 * died on every invocation). The same check build-cli.sh makes.
 */
export function smokeVersion(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      argv[0] as string,
      argv.slice(1),
      { timeout: 60_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}${stderr}`.trim()));
        else resolve(stdout.trim());
      },
    );
  });
}

/**
 * The target's permission bits onto the new file, before the smoke run has
 * to execute it: it was opened 0o600, which nothing can exec.
 */
export async function adoptMode(
  tmp: string,
  target: string,
  platform: NodeJS.Platform,
  io: SwapIo = fsp,
): Promise<void> {
  if (platform === "win32") return;
  let mode = 0o755;
  try {
    mode = (await io.stat(target)).mode & 0o7777;
  } catch {
    // The target vanished mid-run; the usual executable bits will do.
  }
  await io.chmod(tmp, mode);
}

const OLD_MARK = ".old-";

/**
 * Atomic on POSIX: one rename, and a process still running the old file keeps
 * its inode. Windows refuses to overwrite or delete an executable that is
 * running — this one — but lets it be renamed, so the old file steps aside
 * under a unique name first and is swept by a later upgrade.
 */
export async function swap(
  tmp: string,
  target: string,
  platform: NodeJS.Platform,
  io: SwapIo = fsp,
): Promise<void> {
  if (platform !== "win32") {
    try {
      await io.rename(tmp, target);
    } catch (error) {
      throw unreplaceable(target, error);
    }
    return;
  }

  const aside = join(
    dirname(target),
    `.${basename(target)}${OLD_MARK}${randomBytes(6).toString("hex")}`,
  );
  try {
    await io.rename(target, aside);
  } catch (error) {
    throw unreplaceable(target, error);
  }
  try {
    await io.rename(tmp, target);
  } catch (error) {
    await io.rename(aside, target);
    throw unreplaceable(target, error);
  }
  await io.unlink(aside).catch(() => {});
}

/** Best effort: an old executable still running stays until the next run. */
export async function sweepAside(
  target: string,
  io: SwapIo = fsp,
): Promise<void> {
  const prefix = `.${basename(target)}${OLD_MARK}`;
  let names: string[];
  try {
    names = await io.readdir(dirname(target));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(prefix)) {
      await io.unlink(join(dirname(target), name)).catch(() => {});
    }
  }
}
