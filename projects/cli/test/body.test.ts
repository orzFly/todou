import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readBody } from "../src/body.ts";
import { CliError } from "../src/errors.ts";

const dir = mkdtempSync(join(tmpdir(), "todou-body-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function opts(overrides: Partial<Parameters<typeof readBody>[0]>) {
  return {
    stdin: Readable.from([""]),
    isTTY: false,
    env: {},
    cwd: dir,
    ...overrides,
  };
}

describe("readBody", () => {
  it("prefers --body", async () => {
    expect(await readBody(opts({ body: "inline" }))).toBe("inline");
  });

  it("reads stdin for --body-file -", async () => {
    expect(
      await readBody(
        opts({ bodyFile: "-", stdin: Readable.from(["from ", "stdin"]) }),
      ),
    ).toBe("from stdin");
  });

  it("reads a file for --body-file", async () => {
    const file = join(dir, "body.md");
    writeFileSync(file, "from file");
    expect(await readBody(opts({ bodyFile: file }))).toBe("from file");
  });

  // Process substitution (`--body-file <(…)`) hands us a pipe, whose st_size is
  // 0 — a size-trusting read would silently post an empty body. 200KB overruns
  // the 64KB pipe buffer, so the writer must still be blocked when we open.
  it("reads a pipe past the pipe buffer, not its st_size", async () => {
    const fifo = join(dir, "body.fifo");
    execFileSync("mkfifo", [fifo]);
    const writer = spawn("sh", [
      "-c",
      `head -c 200000 /dev/zero | tr '\\0' a > ${fifo}`,
    ]);
    try {
      expect(await readBody(opts({ bodyFile: fifo }))).toHaveLength(200000);
    } finally {
      writer.kill();
    }
  });

  it("fails fast without a TTY", async () => {
    const err = await readBody(opts({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe("no body given");
  });

  it("opens $EDITOR on a TTY and returns the saved text", async () => {
    const body = await readBody(
      opts({
        isTTY: true,
        env: { EDITOR: `sh -c 'printf "edited" > "$0"'` },
      }),
    );
    expect(body).toBe("edited");
  });

  it("treats an empty editor result as an abort", async () => {
    const err = await readBody(
      opts({ isTTY: true, env: { EDITOR: "true" } }),
    ).catch((e: unknown) => e);
    expect((err as CliError).message).toBe("aborted: empty body");
  });
});

describe("readBody guards a --body that is a path (T-198)", () => {
  const notes: string[] = [];
  const note = (line: string) => notes.push(line);
  beforeEach(() => {
    notes.length = 0;
  });

  const refuses = async (body: string) =>
    (await readBody(opts({ body, note })).catch((e: unknown) => e)) as CliError;

  it.each([
    "-",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr",
    // Not stat'd, so a descriptor this process does not hold reads the same.
    "/dev/fd/63",
    "/proc/self/fd/11",
    "/proc/1234/fd/11",
  ])("refuses %s", async (body) => {
    const err = await refuses(body);
    expect(err).toBeInstanceOf(CliError);
    expect(err.message.startsWith(`--body was given ${body},`)).toBe(true);
    expect(err.hint).toContain("nothing was written");
    expect(notes).toEqual([]);
  });

  it("names stdin for -, and a stream path for the rest", async () => {
    expect((await refuses("-")).message).toBe(
      "--body was given -, which is how --body-file spells stdin",
    );
    expect((await refuses("/dev/stdin")).message).toBe(
      "--body was given /dev/stdin, which is a stream path, not body text",
    );
  });

  it("warns on an existing file but still returns the body", async () => {
    writeFileSync(join(dir, "note.md"), "the real body");
    expect(await readBody(opts({ body: "note.md", note }))).toBe("note.md");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("warning: --body was given note.md");
    expect(notes[1]).toContain("not refused, the write goes ahead");
  });

  it("resolves the path against cwd, not the process's", async () => {
    writeFileSync(join(dir, "elsewhere.md"), "x");
    expect(await readBody(opts({ body: "elsewhere.md", cwd: "/", note }))).toBe(
      "elsewhere.md",
    );
    expect(notes).toEqual([]);
  });

  // The warning fires only where --body-file would have worked; everywhere
  // else that flag fails loudly on its own.
  it.each([".", "missing.md", "", "a body mentioning note.md and more"])(
    "stays quiet for %j",
    async (body) => {
      expect(await readBody(opts({ body, note }))).toBe(body);
      expect(notes).toEqual([]);
    },
  );

  it("stays quiet for a multi-line body whose first line is a path", async () => {
    writeFileSync(join(dir, "note.md"), "the real body");
    const body = "note.md\n\nand a second paragraph";
    expect(await readBody(opts({ body, note }))).toBe(body);
    expect(notes).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "stays quiet for a file it cannot read",
    async () => {
      const path = join(dir, "locked.md");
      writeFileSync(path, "x");
      chmodSync(path, 0o000);
      try {
        expect(await readBody(opts({ body: "locked.md", note }))).toBe(
          "locked.md",
        );
        expect(notes).toEqual([]);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it("allowBodyPath silences both levels", async () => {
    writeFileSync(join(dir, "note.md"), "the real body");
    const allow = { allowBodyPath: true, note };
    expect(await readBody(opts({ body: "/dev/stdin", ...allow }))).toBe(
      "/dev/stdin",
    );
    expect(await readBody(opts({ body: "note.md", ...allow }))).toBe("note.md");
    expect(notes).toEqual([]);
  });

  it("leaves --body-file alone", async () => {
    expect(
      await readBody(
        opts({ bodyFile: "-", stdin: Readable.from(["real text"]), note }),
      ),
    ).toBe("real text");
    expect(notes).toEqual([]);
  });
});
