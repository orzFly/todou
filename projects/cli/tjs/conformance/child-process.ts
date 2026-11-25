import type * as cp from "node:child_process";
import { type Cases, equal, ok } from "./assert.ts";

type ChildProcess = typeof cp;

const posix = process.platform !== "win32";

type ExecResult = {
  error: (Error & Record<string, unknown>) | null;
  stdout: string;
  stderr: string;
};

function execFile(
  mod: ChildProcess,
  file: string,
  args: string[],
  options: cp.ExecFileOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    mod.execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        error: error as ExecResult["error"],
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function exitOf(child: cp.ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}

export const cases: Cases<ChildProcess> = {
  "execFile collects stdout and stderr": async (mod) => {
    if (!posix) return;
    const { error, stdout, stderr } = await execFile(mod, "/bin/sh", [
      "-c",
      "printf out; printf err >&2",
    ]);
    equal(error, null, "error");
    equal(stdout, "out", "stdout");
    equal(stderr, "err", "stderr");
  },

  "execFile reports a non-zero exit as an error with the code": async (mod) => {
    if (!posix) return;
    const { error, stdout } = await execFile(mod, "/bin/sh", [
      "-c",
      "echo partial; exit 3",
    ]);
    ok(error !== null, "an error");
    equal(error?.code, 3, "code");
    equal(stdout, "partial\n", "stdout still collected");
  },

  "execFile of a missing program reports ENOENT": async (mod) => {
    const { error } = await execFile(mod, "todou-no-such-program", ["x"]);
    equal(error?.code, "ENOENT", "code");
    equal(error?.message, "spawn todou-no-such-program ENOENT", "message");
  },

  "execFile passes env and cwd": async (mod) => {
    if (!posix) return;
    const { stdout } = await execFile(
      mod,
      "/bin/sh",
      ["-c", 'printf "%s %s" "$TODOU_PROBE" "$(pwd -P)"'],
      { env: { ...process.env, TODOU_PROBE: "seen" }, cwd: "/" },
    );
    equal(stdout, "seen /", "env and cwd");
  },

  "spawn with a shell runs the joined line and reports its exit": async (
    mod,
  ) => {
    if (!posix) return;
    const child = mod.spawn("exit", ["7"], { shell: true, stdio: "ignore" });
    equal(await exitOf(child), 7, "exit code");
  },

  "spawn of a missing program emits error, not a throw": async (mod) => {
    const child = mod.spawn("todou-no-such-program", [], { stdio: "ignore" });
    const error = await new Promise<Error & { code?: string }>((resolve) =>
      child.on("error", resolve),
    );
    equal(error.code, "ENOENT", "code");
  },
};
