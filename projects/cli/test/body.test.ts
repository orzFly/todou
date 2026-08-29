import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { readBody } from "../src/body.ts";
import { CliError } from "../src/errors.ts";

const dir = mkdtempSync(join(tmpdir(), "todou-body-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function opts(overrides: Partial<Parameters<typeof readBody>[0]>) {
  return {
    stdin: Readable.from([""]),
    isTTY: false,
    env: {},
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
