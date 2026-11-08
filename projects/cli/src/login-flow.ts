import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { type Readable, Writable } from "node:stream";
import { type TodouClient, TodouError } from "@todou/shared";
import { type Clock, systemClock } from "./clock.ts";
import { CliError } from "./errors.ts";

/**
 * Tells the web page this listener takes the token as a form POST. A page
 * that predates the flag ignores it and keeps navigating with the token in
 * the query, which is still accepted (T-634).
 */
export const POST_DELIVERY_PARAM = ["delivery", "post"] as const;

const LOGGED_IN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>todou</title>' +
  '<body style="font-family: system-ui; text-align: center; padding-top: 4rem">' +
  "<h1>🥔 Logged in</h1><p>You can close this page and return to the terminal.</p>";

/** Far above any token and state; a local client must not make us buffer without end. */
const MAX_FORM_BYTES = 8 * 1024;

function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        req.removeAllListeners("data");
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))),
    );
    req.on("error", () => resolve(null));
  });
}

/**
 * One-shot loopback listener for the browser's token delivery. Requests with
 * a wrong state or missing token get a 400 and the wait continues — a stray
 * or hostile local request must not consume the pending login.
 *
 * A delivery is answered with a redirect to `/done`, so the address the
 * browser settles on — and keeps in its history — carries no token (T-634).
 * The login completes once `/done` is served, or after `doneGraceMs` for a
 * browser that never follows: closing the listener before then would leave
 * the browser on a connection error instead of the confirmation.
 */
export function waitForCallback(options: {
  state: string;
  timeoutMs: number;
  doneGraceMs?: number;
  onListening: (port: number) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let received: string | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      clearTimeout(grace);
      server.close();
      settle();
    };
    const refuse = (res: ServerResponse) => {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("invalid callback\n");
    };
    const accept = (
      res: ServerResponse,
      status: 302 | 303,
      fields: URLSearchParams,
    ) => {
      const token = fields.get("token");
      if (
        received !== null ||
        fields.get("state") !== options.state ||
        !token
      ) {
        refuse(res);
        return;
      }
      received = token;
      clearTimeout(timer);
      grace = setTimeout(
        () => finish(() => resolve(token)),
        options.doneGraceMs ?? 5_000,
      );
      res.writeHead(status, { location: "/done" });
      res.end();
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/callback" && req.method === "GET") {
        accept(res, 302, url.searchParams);
      } else if (url.pathname === "/callback" && req.method === "POST") {
        // 303, not 302: the follow-up must be a GET that cannot re-submit.
        void readForm(req).then((form) =>
          form ? accept(res, 303, form) : refuse(res),
        );
      } else if (
        url.pathname === "/done" &&
        req.method === "GET" &&
        received !== null
      ) {
        const token = received;
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          connection: "close",
        });
        res.end(LOGGED_IN_PAGE, () => finish(() => resolve(token)));
      } else {
        refuse(res);
      }
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

/**
 * Waits for a browser — anywhere, on any machine — to authorize a pending
 * request. The counterpart to waitForCallback for the case that has no
 * loopback to deliver to: nothing listens locally, the CLI only asks.
 */
export async function pollForApproval(options: {
  client: TodouClient;
  requestId: number;
  pollSecret: string;
  intervalMs: number;
  timeoutMs: number;
  clock?: Clock;
}): Promise<string> {
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + options.timeoutMs;
  while (clock.now() < deadline) {
    try {
      const result = await options.client.pollCliAuthRequest(
        options.requestId,
        { poll_secret: options.pollSecret },
      );
      if (result.status === "approved") return result.token;
      if (result.status === "denied") {
        throw new CliError(
          "login request was denied",
          "re-run `todou login --no-browser` to ask again",
        );
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error instanceof TodouError && error.status === 404) {
        throw new CliError(
          "login request expired or was not found",
          "re-run `todou login --no-browser`",
        );
      }
      // Anything else is a blip between two polls — a restarted server, a
      // dropped connection — and must not lose a login the user may already
      // have authorized. The total timeout is the only thing that gives up.
    }
    await clock.sleep(Math.min(options.intervalMs, deadline - clock.now()));
  }
  throw new CliError(
    "login timed out",
    "re-run `todou login`, or paste a token with --manual",
  );
}

/**
 * On win32, `cmd /c start` would truncate the URL at the first `&` (an
 * unquoted `&` is a command separator to cmd); rundll32 receives the URL as
 * a plain argument with no shell parsing at all.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
): [string, string[]] {
  return platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];
}

/** Best-effort; the auth URL is always printed as the fallback. */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const [cmd, args] = browserCommand(url, platform);
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
