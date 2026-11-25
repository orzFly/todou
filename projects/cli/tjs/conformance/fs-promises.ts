import { execFile } from "node:child_process";
import type * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cases, deepEqual, equal, ok, rejection } from "./assert.ts";

type Fs = typeof fsp;

const posix = process.platform !== "win32";

async function scratch(fs: Fs): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "todou-conformance-"));
}

function symlink(target: string, link: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ln", ["-s", target, link], (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function inScratch(fs: Fs, run: (dir: string) => Promise<void>) {
  const dir = await scratch(fs);
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export const cases: Cases<Fs> = {
  "writeFile and readFile round-trip text and bytes": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "a.txt");
      await fs.writeFile(file, "héllo\n");
      equal(await fs.readFile(file, "utf8"), "héllo\n", "utf8 read");
      const bytes = await fs.readFile(file);
      equal(bytes.length, 7, "byte length");
      equal(bytes.toString("utf8"), "héllo\n", "Buffer.toString");
      await fs.writeFile(file, new Uint8Array([1, 2, 3]));
      deepEqual([...(await fs.readFile(file))], [1, 2, 3], "bytes");
    }),

  "writeFile applies mode to a new file": (fs) =>
    inScratch(fs, async (dir) => {
      if (!posix) return;
      const file = join(dir, "secret");
      await fs.writeFile(file, "x", { mode: 0o600 });
      equal((await fs.stat(file)).mode & 0o777, 0o600, "mode");
    }),

  "writeFile with wx refuses an existing file": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "taken");
      await fs.writeFile(file, "1");
      const error = await rejection(
        () => fs.writeFile(file, "2", { flag: "wx" }),
        "wx",
      );
      equal(error.code, "EEXIST", "code");
      equal(
        error.message,
        `EEXIST: file already exists, open '${file}'`,
        "message",
      );
      equal(await fs.readFile(file, "utf8"), "1", "content kept");
    }),

  "readFile of a missing file says ENOENT with the path": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "missing");
      const error = await rejection(() => fs.readFile(file), "readFile");
      equal(error.code, "ENOENT", "code");
      equal(
        error.message,
        `ENOENT: no such file or directory, open '${file}'`,
        "message",
      );
    }),

  "appendFile appends and creates": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "log");
      await fs.appendFile(file, "a\n");
      await fs.appendFile(file, "b\n");
      equal(await fs.readFile(file, "utf8"), "a\nb\n", "content");
    }),

  "mkdir recursive, and EEXIST without it": (fs) =>
    inScratch(fs, async (dir) => {
      const deep = join(dir, "x", "y", "z");
      equal(
        await fs.mkdir(deep, { recursive: true }),
        join(dir, "x"),
        "first created",
      );
      equal(
        await fs.mkdir(deep, { recursive: true }),
        undefined,
        "nothing created",
      );
      const error = await rejection(() => fs.mkdir(deep), "mkdir");
      equal(error.code, "EEXIST", "code");
      equal(
        error.message,
        `EEXIST: file already exists, mkdir '${deep}'`,
        "message",
      );
    }),

  "mkdtemp appends six characters": (fs) =>
    inScratch(fs, async (dir) => {
      const prefix = join(dir, "t-");
      const made = await fs.mkdtemp(prefix);
      ok(made.startsWith(prefix), "prefix kept");
      equal(made.length, prefix.length + 6, "length");
      ok((await fs.stat(made)).isDirectory(), "is a directory");
    }),

  "readdir sorts names and types entries": (fs) =>
    inScratch(fs, async (dir) => {
      for (const name of ["zeta", "Alpha", "mid", "beta"]) {
        await fs.writeFile(join(dir, name), "");
      }
      await fs.mkdir(join(dir, "sub"));
      const names = await fs.readdir(dir);
      if (posix)
        deepEqual(names, ["Alpha", "beta", "mid", "sub", "zeta"], "order");
      else
        deepEqual(
          [...names].sort(),
          ["Alpha", "beta", "mid", "sub", "zeta"],
          "names",
        );
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const sub = entries.find((entry) => entry.name === "sub");
      ok(sub?.isDirectory() && !sub.isFile(), "sub is a directory");
      ok(
        entries.find((entry) => entry.name === "mid")?.isFile(),
        "mid is a file",
      );
      const missing = join(dir, "nope");
      const error = await rejection(() => fs.readdir(missing), "readdir");
      equal(error.code, "ENOENT", "code");
      equal(
        error.message,
        `ENOENT: no such file or directory, scandir '${missing}'`,
        "message",
      );
    }),

  "stat and lstat": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "f");
      await fs.writeFile(file, "12345");
      const st = await fs.stat(file);
      ok(st.isFile() && !st.isDirectory(), "file");
      equal(st.size, 5, "size");
      ok(st.mtime instanceof Date && st.mtimeMs > 0, "mtime");
      ok((await fs.stat(dir)).isDirectory(), "directory");
      if (!posix) return;
      await symlink(file, join(dir, "link"));
      ok(
        (await fs.lstat(join(dir, "link"))).isSymbolicLink(),
        "lstat sees the link",
      );
      ok((await fs.stat(join(dir, "link"))).isFile(), "stat follows it");
      const error = await rejection(() => fs.stat(join(dir, "nope")), "stat");
      equal(
        error.message,
        `ENOENT: no such file or directory, stat '${join(dir, "nope")}'`,
        "message",
      );
    }),

  "rm with and without force and recursive": (fs) =>
    inScratch(fs, async (dir) => {
      const missing = join(dir, "missing");
      equal(
        (await rejection(() => fs.rm(missing), "rm missing")).code,
        "ENOENT",
        "missing",
      );
      await fs.rm(missing, { force: true });
      const sub = join(dir, "sub");
      await fs.mkdir(sub);
      await fs.writeFile(join(sub, "f"), "");
      equal(
        (await rejection(() => fs.rm(sub), "rm dir")).code,
        "ERR_FS_EISDIR",
        "dir",
      );
      await fs.rm(sub, { recursive: true });
      equal(
        (await rejection(() => fs.stat(sub), "stat")).code,
        "ENOENT",
        "gone",
      );
      await fs.writeFile(join(dir, "f"), "");
      await fs.rm(join(dir, "f"));
    }),

  "unlink removes a file and refuses a directory": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "f");
      await fs.writeFile(file, "");
      await fs.unlink(file);
      equal(
        (await rejection(() => fs.stat(file), "stat")).code,
        "ENOENT",
        "gone",
      );
      const missing = await rejection(() => fs.unlink(file), "unlink missing");
      equal(
        missing.message,
        `ENOENT: no such file or directory, unlink '${file}'`,
        "message",
      );
      if (!posix) return;
      const refused = await rejection(() => fs.unlink(dir), "unlink dir");
      equal(
        refused.code,
        process.platform === "darwin" ? "EPERM" : "EISDIR",
        "dir",
      );
    }),

  "rename moves, and names both paths when it fails": (fs) =>
    inScratch(fs, async (dir) => {
      const from = join(dir, "a");
      const to = join(dir, "b");
      await fs.writeFile(from, "x");
      await fs.rename(from, to);
      equal(await fs.readFile(to, "utf8"), "x", "moved");
      const error = await rejection(() => fs.rename(from, to), "rename");
      equal(
        error.message,
        `ENOENT: no such file or directory, rename '${from}' -> '${to}'`,
        "message",
      );
    }),

  "chmod sets the mode": (fs) =>
    inScratch(fs, async (dir) => {
      if (!posix) return;
      const file = join(dir, "f");
      await fs.writeFile(file, "");
      await fs.chmod(file, 0o751);
      equal((await fs.stat(file)).mode & 0o777, 0o751, "mode");
    }),

  "realpath and readlink resolve a link": (fs) =>
    inScratch(fs, async (dir) => {
      if (!posix) return;
      const real = await fs.realpath(dir);
      await fs.writeFile(join(dir, "target"), "");
      await symlink(join(dir, "target"), join(dir, "link"));
      equal(
        await fs.realpath(join(dir, "link")),
        join(real, "target"),
        "realpath",
      );
      equal(
        await fs.readlink(join(dir, "link")),
        join(dir, "target"),
        "readlink",
      );
    }),

  "access answers for existence": (fs) =>
    inScratch(fs, async (dir) => {
      await fs.access(dir);
      const missing = join(dir, "missing");
      const error = await rejection(() => fs.access(missing), "access");
      equal(error.code, "ENOENT", "code");
      equal(
        error.message,
        `ENOENT: no such file or directory, access '${missing}'`,
        "message",
      );
    }),

  "FileHandle reads and writes at positions": (fs) =>
    inScratch(fs, async (dir) => {
      const file = join(dir, "f");
      const handle = await fs.open(file, "w+");
      try {
        equal((await handle.write("hello world")).bytesWritten, 11, "written");
        const buffer = new Uint8Array(5);
        const { bytesRead } = await handle.read(buffer, 0, 5, 6);
        equal(bytesRead, 5, "bytesRead");
        equal(new TextDecoder().decode(buffer), "world", "read at position");
        equal(
          (await handle.read(new Uint8Array(4), 0, 4, 11)).bytesRead,
          0,
          "at EOF",
        );
        equal((await handle.stat()).size, 11, "stat");
      } finally {
        await handle.close();
      }
      const appended = await fs.open(file, "a");
      await appended.write(new Uint8Array([33]));
      await appended.close();
      equal(await fs.readFile(file, "utf8"), "hello world!", "append mode");
    }),
};
