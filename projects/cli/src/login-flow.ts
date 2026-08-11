import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { type Readable, Writable } from "node:stream";
import { CliError } from "./errors.ts";

/**
 * One-shot loopback listener for the browser's token delivery. Requests with
 * a wrong state or missing token get a 400 and the wait continues — a stray
 * or hostile local request must not consume the pending login.
 */
export function waitForCallback(options: {
  state: string;
  timeoutMs: number;
  onListening: (port: number) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      server.close();
      settle();
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const token = url.searchParams.get("token");
      if (
        url.pathname !== "/callback" ||
        url.searchParams.get("state") !== options.state ||
        !token
      ) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("invalid callback\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>todou</title>' +
          '<body style="font-family: system-ui; text-align: center; padding-top: 4rem">' +
          "<h1>🥔 Logged in</h1><p>You can close this page and return to the terminal.</p>",
      );
      finish(() => resolve(token));
    });
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new CliError(
            "login timed out",
            "re-run `todou login`, or paste a token with --manual",
          ),
        ),
      );
    }, options.timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      options.onListening((server.address() as AddressInfo).port);
    });
  });
}

/** Best-effort; the auth URL is always printed as the fallback. */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const [cmd, args]: [string, string[]] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed URL is the fallback.
  }
}

/** Prompt on stderr, read one line without echoing it on a TTY. */
export function promptHidden(
  stdin: Readable,
  stderr: Writable,
  prompt: string,
): Promise<string> {
  stderr.write(prompt);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({
    input: stdin,
    output: muted,
    terminal: Boolean((stdin as { isTTY?: boolean }).isTTY),
  });
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      stderr.write("\n");
      resolve(answer.trim());
    });
  });
}
