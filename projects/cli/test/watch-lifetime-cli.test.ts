import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const ownerFixture = fileURLToPath(
  new URL("./fixtures/watch-owner.mjs", import.meta.url),
);
// These tests deliberately exercise another process's platform timers and
// process exit. Fake timers cannot drive the unmodified CLI child.
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
type OwnerRecord = {
  v: number;
  pid: number;
  agent: string;
  session_id: string;
  socket: string;
  token: string;
};
type Started = { path: string; record: OwnerRecord; childPid: number };

/** ESRCH proves reaping; an orphan zombie has exited but awaits its new parent. */
function processState(pid: number | undefined): "gone" | "alive" | "zombie" {
  if (pid === undefined) return "gone";
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    throw error;
  }
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      if (/^State:\s+Z\b/m.test(status)) return "zombie";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
      throw error;
    }
  }
  return "alive";
}

async function fixture(
  args: string[],
  opts: {
    peer?: "omp" | "pi";
    scenario?: "idle" | "debounce" | "retry" | "setup";
    bare?: boolean;
    reparent?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "todou-watch-lifetime-"));
  const sockets = new Set<Socket>();
  let drains = 0;
  let requests = 0;
  let feeds = 0;
  let stdout = "";
  let stderr = "";
  let closed = false;
  let launcherExited = false;
  let closeCode: number | null = null;
  let started: Started | undefined;
  let childExit: { code: number | null; signal: string | null } | undefined;
  let child: ChildProcess | undefined;
  const scenario = opts.scenario ?? "idle";
  const server = createServer((req, res) => {
    requests += 1;
    const url = new URL(req.url ?? "/", "http://fixture.test");
    if (scenario === "setup") return; // Pending initial /me must be abortable.
    if (url.pathname === "/api/events") {
      feeds += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": fixture ready\n\n");
      res.on("close", () => {
        feeds -= 1;
      });
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/me") {
      res.end(
        JSON.stringify({
          id: 2,
          login: "fixture-agent",
          display_name: "Fixture",
          kind: "machine",
          owner: null,
        }),
      );
      return;
    }
    if (
      url.pathname.endsWith("/activity") ||
      url.pathname.endsWith("/timeline")
    ) {
      drains += 1;
      if (scenario === "retry") {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "fixture outage" }));
        return;
      }
      const items =
        scenario === "debounce" && drains === 1
          ? [
              {
                type: "comment",
                id: 11,
                issue_number: 7,
                project: "acme",
                author: {
                  id: 3,
                  login: "alice",
                  display_name: "Alice",
                  kind: "human",
                  owner: null,
                },
                body: "collected before owner rotation",
                created_at: new Date().toISOString(),
                edited_at: null,
              },
            ]
          : [];
      res.end(
        JSON.stringify({
          items,
          next_cursor: items.length ? "c1" : "c0",
          has_more: false,
        }),
      );
      return;
    }
    // Ref spelling/card lookups are best effort. No fixture depends on them.
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const cleanup = async () => {
    // Kill the real CLI first, including after its owner was killed. In a
    // failed assertion this is the only remaining owner of that child PID.
    const cliPid = started?.childPid ?? (opts.bare ? child?.pid : undefined);
    if (processState(cliPid) === "alive" && cliPid !== undefined) {
      try {
        process.kill(cliPid, "SIGKILL");
      } catch {}
    }
    if (child !== undefined && !closed) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) =>
        child?.once("close", () => resolve()),
      );
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      XDG_CONFIG_HOME: root,
      XDG_STATE_HOME: root,
      TODOU_SERVER: `http://127.0.0.1:${port}`,
      TODOU_TOKEN: "todou_pat_fixture",
      ...(opts.reparent ? { TODOU_FIXTURE_REPARENT: "1" } : {}),
    };
    child = opts.bare
      ? spawn(process.execPath, [cli, ...args], {
          cwd: root,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(
          process.execPath,
          [ownerFixture, root, opts.peer ?? "omp", cli, ...args],
          {
            cwd: root,
            env,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("message", (message) => {
      const value = message as Started & {
        childExit?: typeof childExit;
        launcherExited?: boolean;
      };
      if (value.childPid !== undefined) started = value;
      if (value.childExit !== undefined) childExit = value.childExit;
      if (value.launcherExited) launcherExited = true;
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    // Pipe closure is only a synchronization point. Assertions below probe
    // the actual child PID too, so closing stdio cannot fake process exit.
    child.on("close", (code) => {
      closed = true;
      closeCode = code;
    });
    const until = async (
      predicate: () => boolean,
      label: string,
      timeout = 6_000,
    ) => {
      const deadline = Date.now() + timeout;
      while (!predicate() && Date.now() < deadline) await pause(20);
      expect(predicate(), `${label}; stdout=${stdout}; stderr=${stderr}`).toBe(
        true,
      );
    };
    await until(
      () => (opts.bare ? requests > 0 : started !== undefined),
      "real child started",
    );
    await until(
      () => (scenario === "setup" ? requests > 0 : drains > 0),
      "tracker request reached",
    );
    if (scenario === "retry")
      await until(() => stderr.includes("retrying in"), "retry sleep entered");
    return {
      get started() {
        return started;
      },
      get stdout() {
        return stdout;
      },
      get stderr() {
        return stderr;
      },
      get closed() {
        return closed;
      },
      get closeCode() {
        return closeCode;
      },
      get childExit() {
        return childExit;
      },
      get drains() {
        return drains;
      },
      get feeds() {
        return feeds;
      },
      get processState() {
        return processState(started?.childPid ?? child?.pid);
      },
      until,
      cleanup,
      killOwner: () => child?.kill("SIGTERM"),
      detachLauncher: () => child?.send("detach"),
      get launcherExited() {
        return launcherExited;
      },
      rewrite: (change: Partial<OwnerRecord> = {}) => {
        if (started === undefined) throw new Error("no native owner");
        const next = { ...started.record, ...change };
        writeFileSync(`${started.path}.next`, JSON.stringify(next));
        renameSync(`${started.path}.next`, started.path);
      },
      remove: () => {
        if (started !== undefined) rmSync(started.path);
      },
      witness: (mutation: string) => {
        if (process.env.TODOU_LIFECYCLE_WITNESS !== "1") return;
        const snapshot =
          started !== undefined && existsSync(started.path)
            ? (JSON.parse(readFileSync(started.path, "utf8")) as OwnerRecord)
            : undefined;
        console.log(
          `raw watch ${mutation}: pid=${started?.childPid} ${processState(started?.childPid)}; session=${snapshot?.session_id ?? "missing"}; tokenChanged=${snapshot?.token !== started?.record.token}`,
        );
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const variants = [
  ["project", ["watch", "-p", "acme"]],
  ["issue", ["issue", "watch", "7", "-p", "acme"]],
  ["multi-project", ["watch", "-p", "acme,beta"]],
  ["all-projects", ["watch", "--all-projects"]],
] as const;

describe("real CLI native watch lifetime", () => {
  for (const peer of ["omp", "pi"] as const) {
    it.each(variants)(
      `${peer} %s remains alive in the same session then exits on session change`,
      async (_name, command) => {
        const f = await fixture(
          [
            ...command,
            "--follow",
            "--since",
            "c0",
            "--json",
            "--interval",
            "3600",
          ],
          { peer },
        );
        try {
          f.rewrite();
          await pause(1_250);
          expect(f.closed).toBe(false);
          expect(f.processState).toBe("alive");
          expect(f.drains).toBe(1); // no new activity is needed to detect rotation
          f.rewrite({ session_id: "fixture-session-two" });
          await pause(1_250);
          f.witness("session rotation");
          await f.until(() => f.closed, "old CLI exits on session rotation");
          await f.until(
            () => f.processState === "gone",
            "old CLI PID is reaped",
          );
          expect(f.childExit).toEqual({ code: 0, signal: null });
          expect(f.stdout).toContain('"next_cursor":"c0"');
          expect(f.stderr).toContain(
            "native session owner changed or disappeared",
          );
          expect(f.feeds).toBe(0);
        } finally {
          await f.cleanup();
        }
      },
      15_000,
    );
  }

  it.each(["token", "missing", "dead"] as const)(
    "ordinary --forever exits on %s owner",
    async (mutation) => {
      const f = await fixture([
        "watch",
        "-p",
        "acme",
        "--forever",
        "--since",
        "c0",
        "--json",
        "--interval",
        "3600",
      ]);
      try {
        if (mutation === "token") f.rewrite({ token: "fixture-token-two" });
        else if (mutation === "missing") f.remove();
        else f.killOwner();
        await pause(1_250);
        f.witness(mutation);
        await f.until(() => f.closed, `old CLI exits after ${mutation}`);
        // With a living owner, ESRCH proves the CLI was reaped. An orphan
        // may remain a Linux zombie until PID 1 reaps it; Z proves it exited,
        // unlike a process that merely closed the inherited output pipes.
        if (mutation === "dead") {
          await f.until(() => f.processState !== "alive", "orphan CLI exited");
          if (f.processState === "zombie") {
            console.log(
              `orphan CLI pid=${f.started?.childPid} exited; awaiting PID 1 reaping (State: Z)`,
            );
          }
        } else {
          await f.until(
            () => f.processState === "gone",
            "old CLI PID is reaped",
          );
          expect(f.childExit).toEqual({ code: 0, signal: null });
        }
        expect(f.stdout).toContain('"next_cursor":"c0"');
        expect(f.stderr).toContain(
          "native session owner changed or disappeared",
        );
        expect(f.feeds).toBe(0);
      } finally {
        await f.cleanup();
      }
    },
    15_000,
  );

  it.each(["setup", "retry", "debounce"] as const)(
    "exits and frees resources during %s",
    async (scenario) => {
      const f = await fixture(
        [
          "watch",
          "-p",
          "acme",
          scenario === "debounce" ? "--follow=uds" : "--forever",
          "--since",
          "c0",
          "--json",
          "--interval",
          "3600",
          "--debounce",
          "3600",
        ],
        { scenario },
      );
      try {
        if (scenario === "debounce") {
          await f.until(
            () => f.stderr.includes("--follow=uds following"),
            "push listener opened",
          );
        }
        f.rewrite({ token: "fixture-token-two" });
        await pause(1_250);
        f.witness(scenario);
        await f.until(() => f.closed, `CLI exits during ${scenario}`);
        await f.until(() => f.processState === "gone", "old CLI PID is reaped");
        expect(f.childExit).toEqual({ code: 0, signal: null });
        expect(f.stderr).not.toContain("giving up after");
        expect(f.feeds).toBe(0);
        if (scenario === "debounce") {
          expect(f.stdout).toContain("collected before owner rotation");
          expect(f.stdout).toContain('"next_cursor":"c1"');
          const owner = f.started;
          expect(owner).toBeDefined();
          expect(
            existsSync(
              join(
                owner?.record.socket ?? "",
                "..",
                `no-reply-todou-watch-${owner?.childPid}.sock`,
              ),
            ),
          ).toBe(false);
        }
      } finally {
        await f.cleanup();
      }
    },
    15_000,
  );

  it("keeps the captured owner after a background watch is reparented", async () => {
    const f = await fixture(
      [
        "watch",
        "-p",
        "acme",
        "--forever",
        "--since",
        "c0",
        "--json",
        "--interval",
        "3600",
      ],
      { reparent: true },
    );
    try {
      // Reaching the tracker proves initial ancestry was verified before
      // the intermediary exits. The native owner itself remains alive.
      f.detachLauncher();
      await f.until(() => f.launcherExited, "intermediate launcher exited");
      await pause(1_250);
      expect(processState(f.started?.record.pid)).toBe("alive");
      expect(f.processState).toBe("alive");
      expect(f.stderr).not.toContain("native session owner changed");
      f.rewrite({ session_id: "fixture-session-two" });
      await f.until(
        () => f.processState !== "alive",
        "reparented watch exits on owner rotation",
      );
      expect(f.stdout).toContain('"next_cursor":"c0"');
      expect(f.stderr).toContain("native session owner changed or disappeared");
      expect(f.feeds).toBe(0);
      if (f.processState === "zombie") {
        console.log(
          `reparented CLI pid=${f.started?.childPid} exited; awaiting PID 1 reaping (State: Z)`,
        );
      }
    } finally {
      await f.cleanup();
    }
  }, 15_000);

  it("leaves an ordinary shell watch alive without a verified owner", async () => {
    const f = await fixture(
      [
        "watch",
        "-p",
        "acme",
        "--forever",
        "--since",
        "c0",
        "--json",
        "--interval",
        "3600",
      ],
      { bare: true },
    );
    try {
      await pause(1_250);
      expect(f.closed).toBe(false);
      expect(f.processState).toBe("alive");
      expect(f.stderr).not.toContain("native session owner");
    } finally {
      await f.cleanup();
    }
  }, 15_000);
});
