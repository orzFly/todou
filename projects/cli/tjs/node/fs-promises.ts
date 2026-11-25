// node:fs/promises for the tjs build: the names design.md's subset table
// lists, on tjs' asynchronous file API.
import { Buffer } from "buffer";
import { platform } from "../platform.ts";
import { call, makeSystemError } from "./errors.ts";

type Encoding = "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1";
type EncodingOption = Encoding | { encoding?: Encoding | null } | null;
type Data = string | Uint8Array;

const F_OK = 0;
const W_OK = 2;
const X_OK = 1;

function encodingOf(options: EncodingOption | undefined): Encoding | null {
  if (options === undefined || options === null) return null;
  return typeof options === "string" ? options : (options.encoding ?? null);
}

function bytesOf(data: Data, encoding: Encoding | null = null): Uint8Array {
  return typeof data === "string"
    ? Buffer.from(data, encoding ?? "utf8")
    : data;
}

class Stats {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly rdev: number;
  readonly size: number;
  readonly blksize: number;
  readonly blocks: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;
  readonly #result: tjs.StatResult;

  constructor(result: tjs.StatResult) {
    this.#result = result;
    this.dev = result.dev;
    this.ino = result.ino;
    this.mode = result.mode;
    this.nlink = result.nlink;
    this.uid = result.uid;
    this.gid = result.gid;
    this.rdev = result.rdev;
    this.size = result.size;
    this.blksize = result.blksize;
    this.blocks = result.blocks;
    this.atime = result.atim;
    this.mtime = result.mtim;
    this.ctime = result.ctim;
    this.birthtime = result.birthtim;
    this.atimeMs = result.atim.getTime();
    this.mtimeMs = result.mtim.getTime();
    this.ctimeMs = result.ctim.getTime();
    this.birthtimeMs = result.birthtim.getTime();
  }

  isFile(): boolean {
    return this.#result.isFile;
  }
  isDirectory(): boolean {
    return this.#result.isDirectory;
  }
  isSymbolicLink(): boolean {
    return this.#result.isSymbolicLink;
  }
  isFIFO(): boolean {
    return this.#result.isFIFO;
  }
  isSocket(): boolean {
    return this.#result.isSocket;
  }
  isBlockDevice(): boolean {
    return this.#result.isBlockDevice;
  }
  isCharacterDevice(): boolean {
    return this.#result.isCharacterDevice;
  }
}

class Dirent {
  readonly name: string;
  readonly parentPath: string;
  readonly #entry: tjs.DirEnt;

  constructor(entry: tjs.DirEnt, parentPath: string) {
    this.#entry = entry;
    this.name = entry.name;
    this.parentPath = parentPath;
  }

  isFile(): boolean {
    return this.#entry.isFile;
  }
  isDirectory(): boolean {
    return this.#entry.isDirectory;
  }
  isSymbolicLink(): boolean {
    return this.#entry.isSymbolicLink;
  }
  isFIFO(): boolean {
    return this.#entry.isFIFO;
  }
  isSocket(): boolean {
    return this.#entry.isSocket;
  }
  isBlockDevice(): boolean {
    return this.#entry.isBlockDevice;
  }
  isCharacterDevice(): boolean {
    return this.#entry.isCharacterDevice;
  }
}

/** Node's FileHandle, as far as the subset reaches: read, write, stat, close. */
class FileHandle {
  readonly #handle: tjs.FileHandle;
  readonly #path: string;

  constructor(handle: tjs.FileHandle, path: string) {
    this.#handle = handle;
    this.#path = path;
  }

  /**
   * `read(buffer, offset, length, position)` or `read({ buffer, … })`. A null
   * or omitted position reads from the current one, as Node's does.
   */
  async read(
    bufferOrOptions?:
      | Uint8Array
      | {
          buffer?: Uint8Array;
          offset?: number;
          length?: number;
          position?: number | null;
        },
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    let buffer: Uint8Array;
    if (bufferOrOptions instanceof Uint8Array) {
      buffer = bufferOrOptions;
    } else {
      buffer = bufferOrOptions?.buffer ?? Buffer.alloc(16384);
      offset = bufferOrOptions?.offset;
      length = bufferOrOptions?.length;
      position = bufferOrOptions?.position;
    }
    const start = offset ?? 0;
    const end = start + (length ?? buffer.length - start);
    const n = await call("read", undefined, () =>
      this.#handle.read(
        buffer.subarray(start, end),
        position === null || position === undefined ? undefined : position,
      ),
    );
    return { bytesRead: n ?? 0, buffer };
  }

  /**
   * `write(buffer, offset?, length?, position?)` or `write(string, position?,
   * encoding?)`. Loops until every byte is down, as Node's writeFile does
   * and a single write(2) need not.
   */
  async write(
    data: Data,
    offsetOrPosition?: number | null,
    lengthOrEncoding?: number | Encoding,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Data }> {
    let bytes: Uint8Array;
    let at: number | null | undefined;
    if (typeof data === "string") {
      bytes = bytesOf(
        data,
        typeof lengthOrEncoding === "string" ? lengthOrEncoding : null,
      );
      at = offsetOrPosition;
    } else {
      const start = offsetOrPosition ?? 0;
      const length =
        typeof lengthOrEncoding === "number"
          ? lengthOrEncoding
          : data.length - start;
      bytes = data.subarray(start, start + length);
      at = position;
    }
    let written = 0;
    while (written < bytes.length) {
      const n = await call("write", undefined, () =>
        this.#handle.write(
          bytes.subarray(written),
          at === null || at === undefined ? undefined : at + written,
        ),
      );
      written += n;
    }
    return { bytesWritten: written, buffer: data };
  }

  async stat(): Promise<Stats> {
    return new Stats(await call("fstat", undefined, () => this.#handle.stat()));
  }

  async close(): Promise<void> {
    await call("close", undefined, () => this.#handle.close());
  }

  get path(): string {
    return this.#path;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function open(
  path: string,
  flags: string = "r",
  mode: number = 0o666,
): Promise<FileHandle> {
  const handle = await call("open", path, () => tjs.open(path, flags, mode));
  return new FileHandle(handle, path);
}

export async function readFile(path: string): Promise<Buffer>;
export async function readFile(
  path: string,
  options: Encoding | { encoding: Encoding },
): Promise<string>;
export async function readFile(
  path: string,
  options?: EncodingOption,
): Promise<Buffer | string>;
export async function readFile(
  path: string,
  options?: EncodingOption,
): Promise<Buffer | string> {
  const bytes = Buffer.from(await call("open", path, () => tjs.readFile(path)));
  const encoding = encodingOf(options);
  return encoding === null ? bytes : bytes.toString(encoding);
}

type WriteOptions =
  | Encoding
  | { encoding?: Encoding | null; mode?: number; flag?: string }
  | null;

async function writeWith(
  path: string,
  data: Data,
  options: WriteOptions | undefined,
  defaultFlag: string,
): Promise<void> {
  const settings =
    typeof options === "object" && options !== null ? options : {};
  const handle = await open(
    path,
    settings.flag ?? defaultFlag,
    settings.mode ?? 0o666,
  );
  try {
    await handle.write(bytesOf(data, encodingOf(options ?? null)));
  } finally {
    await handle.close();
  }
}

export function writeFile(
  path: string,
  data: Data,
  options?: WriteOptions,
): Promise<void> {
  return writeWith(path, data, options, "w");
}

export function appendFile(
  path: string,
  data: Data,
  options?: WriteOptions,
): Promise<void> {
  return writeWith(path, data, options, "a");
}

export async function mkdir(
  path: string,
  options?: number | { recursive?: boolean; mode?: number },
): Promise<string | undefined> {
  const settings =
    typeof options === "number" ? { mode: options } : (options ?? {});
  if (settings.recursive) {
    // Node answers with the first directory it had to create, or undefined
    // when the whole path already existed.
    let first: string | undefined;
    let probe = path;
    for (;;) {
      try {
        await tjs.stat(probe);
        break;
      } catch {
        first = probe;
        const parent = probe.replace(/[\\/][^\\/]*$/, "");
        if (parent === probe || parent === "") break;
        probe = parent;
      }
    }
    await call("mkdir", path, () =>
      tjs.makeDir(path, { recursive: true, mode: settings.mode ?? 0o777 }),
    );
    return first;
  }
  await call("mkdir", path, () =>
    tjs.makeDir(path, { mode: settings.mode ?? 0o777 }),
  );
  return undefined;
}

export function mkdtemp(prefix: string): Promise<string> {
  return call("mkdtemp", `${prefix}XXXXXX`, () =>
    tjs.makeTempDir(`${prefix}XXXXXX`),
  );
}

export async function readdir(
  path: string,
  options?: { withFileTypes?: false; encoding?: "utf8" } | "utf8",
): Promise<string[]>;
export async function readdir(
  path: string,
  options: { withFileTypes: true },
): Promise<Dirent[]>;
export async function readdir(
  path: string,
  options?: { withFileTypes?: boolean; encoding?: "utf8" } | "utf8",
): Promise<string[] | Dirent[]> {
  const entries: tjs.DirEnt[] = [];
  const dir = await call("scandir", path, () => tjs.readDir(path));
  try {
    for await (const entry of dir) entries.push(entry);
  } finally {
    await dir.close();
  }
  // Node reads a directory through uv_fs_scandir, which sorts the names
  // bytewise on Unix; tjs' directory handle hands them over in on-disk order.
  // Windows enumerates in the same order through either.
  if (platform !== "win32") {
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  if (typeof options === "object" && options.withFileTypes) {
    return entries.map((entry) => new Dirent(entry, path));
  }
  return entries.map((entry) => entry.name);
}

export async function stat(path: string): Promise<Stats> {
  return new Stats(await call("stat", path, () => tjs.stat(path)));
}

export async function lstat(path: string): Promise<Stats> {
  return new Stats(await call("lstat", path, () => tjs.lstat(path)));
}

/**
 * tjs.remove is `rm -rf`. Node's rm refuses a directory without
 * `recursive` and a missing path without `force`, so those two answers are
 * decided here first, from the same lstat Node's own rm starts with.
 */
export async function rm(
  path: string,
  options?: { recursive?: boolean; force?: boolean },
): Promise<void> {
  let target: tjs.StatResult;
  try {
    target = await call("lstat", path, () => tjs.lstat(path));
  } catch (error) {
    if (options?.force && (error as { code?: string }).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (target.isDirectory && !options?.recursive) {
    const error = new Error(
      `Path is a directory: rm returned EISDIR (is a directory) ${path}`,
    ) as Error & { code: string };
    error.code = "ERR_FS_EISDIR";
    throw error;
  }
  await call("rm", path, () => tjs.remove(path));
}

export async function unlink(path: string): Promise<void> {
  const target = await call("unlink", path, () => tjs.lstat(path));
  if (target.isDirectory) {
    throw makeSystemError(
      platform === "darwin" ? "EPERM" : "EISDIR",
      platform === "darwin"
        ? "operation not permitted"
        : "illegal operation on a directory",
      "unlink",
      path,
    );
  }
  await call("unlink", path, () => tjs.remove(path));
}

export function rename(oldPath: string, newPath: string): Promise<void> {
  return call("rename", oldPath, () => tjs.rename(oldPath, newPath), newPath);
}

export function chmod(path: string, mode: number): Promise<void> {
  return call("chmod", path, () => tjs.chmod(path, mode));
}

export function realpath(path: string): Promise<string> {
  return call("realpath", path, () => tjs.realPath(path));
}

export function readlink(path: string): Promise<string> {
  return call("readlink", path, () => tjs.readLink(path));
}

/**
 * tjs has no access(2). Existence is a stat; the permission bits are read
 * off the mode, which is what access(2) answers for anyone but root. Windows
 * has no execute bit, and Node treats X_OK there as F_OK.
 */
export async function access(path: string, mode: number = F_OK): Promise<void> {
  const target = await call("access", path, () => tjs.stat(path));
  const missing =
    (mode & W_OK && (target.mode & 0o222) === 0) ||
    (mode & X_OK && platform !== "win32" && (target.mode & 0o111) === 0);
  if (missing) {
    throw makeSystemError("EACCES", "permission denied", "access", path);
  }
}
