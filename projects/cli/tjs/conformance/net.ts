import { mkdtemp, rm, stat } from "node:fs/promises";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cases, equal, rejection } from "./assert.ts";

type Net = typeof net;

// Named pipes take a different path form and leave no node to inspect; the
// Windows half of the transport is what the real-machine run covers.
const posix = process.platform !== "win32";

async function inScratch(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "todou-conformance-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function listen(server: net.Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

/** peer-push's dial: one frame per connection, write side ended after it. */
function dial(mod: Net, path: string, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = mod.connect(path);
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.end(payload, () => {
        socket.destroy();
        resolve();
      }),
    );
  });
}

export const cases: Cases<Net> = {
  "a frame written and ended arrives whole, then end and close": (mod) =>
    inScratch(async (dir) => {
      if (!posix) return;
      const path = join(dir, "s.sock");
      const events: string[] = [];
      let received = "";
      const closed = new Promise<void>((resolve) => {
        const server = mod.createServer((socket) => {
          socket.setEncoding("utf8");
          socket.on("data", (chunk) => {
            received += chunk;
          });
          socket.on("end", () => events.push("end"));
          socket.on("close", () => {
            events.push("close");
            server.close();
            resolve();
          });
        });
        void listen(server, path).then(() =>
          dial(mod, path, "first line\nsecond"),
        );
      });
      await closed;
      equal(received, "first line\nsecond", "payload");
      equal(events.join(","), "end,close", "events");
    }),

  "close removes the socket node": (mod) =>
    inScratch(async (dir) => {
      if (!posix) return;
      const path = join(dir, "s.sock");
      const server = mod.createServer(() => {});
      await listen(server, path);
      equal((await stat(path)).isSocket(), true, "listening node");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const error = await rejection(() => stat(path), "stat after close");
      equal(error.code, "ENOENT", "node removed");
    }),

  "connect to nothing says ENOENT": (mod) =>
    inScratch(async (dir) => {
      if (!posix) return;
      const path = join(dir, "absent.sock");
      const error = await rejection(() => dial(mod, path, "x"), "dial");
      equal(error.code, "ENOENT", "code");
      equal(error.message, `connect ENOENT ${path}`, "message");
    }),

  "listen on a taken path says EADDRINUSE": (mod) =>
    inScratch(async (dir) => {
      if (!posix) return;
      const path = join(dir, "s.sock");
      const first = mod.createServer(() => {});
      await listen(first, path);
      try {
        const error = await rejection(
          () =>
            listen(
              mod.createServer(() => {}),
              path,
            ),
          "second listen",
        );
        equal(error.code, "EADDRINUSE", "code");
        equal(
          error.message,
          `listen EADDRINUSE: address already in use ${path}`,
          "message",
        );
      } finally {
        await new Promise<void>((resolve) => first.close(() => resolve()));
      }
    }),
};
