import { PassThrough, Readable } from "node:stream";
import { Builtins, Cli } from "clipanion";
import type { CliContext } from "../src/api-command.ts";
import { commands } from "../src/commands/index.ts";

export type Captured = { url: string; init: RequestInit };

export type Route = [
  method: string,
  path: string,
  reply: unknown | ((init: RequestInit, url: URL) => unknown),
];

/**
 * Route-table fetch stub: matches on method + pathname, replies 200 JSON.
 * Reply `{ __status: n, body }` to force a status; unmatched requests throw
 * so tests never silently talk past the stub.
 */
export function fakeFetch(routes: Route[]) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "http://stub.test");
    calls.push({ url: String(input), init: init ?? {} });
    const method = init?.method ?? "GET";
    const route = routes.find(
      ([m, p]) =>
        m.toUpperCase() === method.toUpperCase() && p === url.pathname,
    );
    if (!route) {
      throw new Error(`unexpected fetch: ${method} ${url.pathname}`);
    }
    const raw =
      typeof route[2] === "function"
        ? (route[2] as (init: RequestInit, url: URL) => unknown)(
            init ?? {},
            url,
          )
        : route[2];
    const forced = raw as { __status?: number; body?: unknown };
    const status = forced?.__status ?? 200;
    const body = forced?.__status !== undefined ? forced.body : raw;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export async function runCli(
  argv: string[],
  options: {
    fetchImpl?: typeof fetch;
    env?: Record<string, string | undefined>;
    cwd?: string;
    stdinText?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cli = new Cli<CliContext>({
    binaryLabel: "todou",
    binaryName: "todou",
    binaryVersion: "0.0.0-test",
  });
  for (const command of commands) {
    cli.register(command);
  }
  cli.register(Builtins.HelpCommand);

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));

  const exitCode = await cli.run(argv, {
    stdin: Readable.from([options.stdinText ?? ""]),
    stdout,
    stderr,
    colorDepth: 1,
    // Real user config/state must never leak into tests, so XDG always
    // points somewhere that does not exist unless the test overrides it.
    env: {
      XDG_CONFIG_HOME: "/nonexistent-todou-xdg",
      XDG_STATE_HOME: "/nonexistent-todou-xdg",
      ...options.env,
    },
    cwd: options.cwd ?? "/",
    fetchImpl: options.fetchImpl,
  });

  return {
    exitCode,
    stdout: Buffer.concat(outChunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  };
}

/** Context vars for a logged-in session without touching the filesystem. */
export function loggedInEnv(project?: string): Record<string, string> {
  return {
    TODOU_SERVER: "http://stub.test",
    TODOU_TOKEN: "todou_pat_test",
    ...(project ? { TODOU_PROJECT: project } : {}),
  };
}
