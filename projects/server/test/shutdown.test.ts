import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

// Generous next to the healthy exit time (tens of ms), tight next to the
// failure modes this guards against: the 28s heartbeat-timer linger and the
// pre-T-26 infinite hang that systemd SIGKILLed after ~90s of outage (T-56).
const EXIT_BUDGET_MS = 3_000;

type RunningServer = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  exited: Promise<number | null>;
};

async function startServer(): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "todou-shutdown-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    [
      "[database]",
      'system = "pglite://memory/shutdown-test"',
      "[storage]",
      `path = '${dir}'`,
    ].join("\n"),
  );
  const child = spawn(
    process.execPath,
    ["src/index.ts", "serve", "--config", configPath, "--port", "0"],
    { cwd: SERVER_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/listening on :(\d+)/);
      if (match) resolve(Number(match[1]));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", () =>
      reject(new Error(`server exited before listening:\n${output}`)),
    );
  });
  return { child, port, exited };
}

async function readUntilHello(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("event: hello")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before hello");
    buffer += decoder.decode(value, { stream: true });
  }
}

describe("serve shutdown (T-56)", () => {
  let server: RunningServer | undefined;

  afterEach(() => {
    server?.child.kill("SIGKILL");
    server = undefined;
  });

  it("exits promptly and cleanly on SIGTERM when idle", async () => {
    server = await startServer();
    const start = Date.now();
    server.child.kill("SIGTERM");
    const code = await server.exited;
    expect(Date.now() - start).toBeLessThan(EXIT_BUDGET_MS);
    expect(code).toBe(0);
  }, 20_000);

  it("exits promptly on SIGTERM with a live SSE stream, ending it server-side", async () => {
    server = await startServer();
    const base = `http://127.0.0.1:${server.port}`;

    const login = await fetch(`${base}/api/auth/login`, { method: "POST" });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") as string).split(
      ";",
    )[0] as string;
    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "live", name: "Live" }),
    });
    expect(created.status).toBe(201);

    const res = await fetch(`${base}/api/projects/live/events`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readUntilHello(reader);

    const start = Date.now();
    server.child.kill("SIGTERM");
    // The stream must END (reader sees done), not error out: the graceful
    // path finishes the response instead of severing the socket.
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    const code = await server.exited;
    expect(Date.now() - start).toBeLessThan(EXIT_BUDGET_MS);
    expect(code).toBe(0);
  }, 20_000);
});
