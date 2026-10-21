import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { codexTarget, openCodexPush } from "../src/codex-push.ts";
import { harnessMessaging } from "../src/harness/messaging.ts";
import { followTransport, openFollow } from "../src/watch-follow.ts";
import { runWatchLoop } from "../src/watch-loop.ts";
import {
  fakeFetch,
  loggedInEnv,
  runCli,
  sseStub,
  virtualClock,
} from "./harness.ts";

const THREAD = "01900000-0000-7000-8000-000000000001";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Request = { id: number; method: string; params: Record<string, unknown> };
async function daemon(
  options: {
    state?: string;
    identity?: string;
    delivery?: "reject" | "drop" | "timeout" | "invalid";
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "todou-codex-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socket = join(dir, "control.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const requests: Request[] = [];
  const extensions: Array<string | undefined> = [];
  const clientResponses: unknown[] = [];
  const thread = {
    id: options.identity ?? THREAD,
    status: { type: options.state ?? "active" },
  };
  server.on("connection", (client, upgrade) => {
    extensions.push(upgrade.headers["sec-websocket-extensions"]);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (!message.method) {
        clientResponses.push(message);
        return;
      }
      if (message.id === undefined) return;
      requests.push(message);
      const reply = (result: unknown) =>
        client.send(JSON.stringify({ id: message.id, result }));
      switch (message.method) {
        case "initialize":
          reply({ userAgent: "codex/test" });
          break;
        case "thread/read":
        case "thread/resume":
          reply({ thread });
          break;
        case "turn/start":
          if (options.delivery === "drop") {
            client.terminate();
            break;
          }
          if (options.delivery === "timeout") break;
          if (options.delivery === "reject") {
            client.send(
              JSON.stringify({
                id: message.id,
                error: { code: -32602, message: "private input must not leak" },
              }),
            );
            break;
          }
          reply(
            options.delivery === "invalid" ? {} : { turn: { id: "turn-test" } },
          );
          break;
        default:
          client.send(
            JSON.stringify({ id: message.id, error: { code: -32601 } }),
          );
      }
    });
  });
  http.listen(socket);
  await once(http, "listening");
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return {
    target: { threadId: THREAD, socket },
    requests,
    server,
    extensions,
    clientResponses,
  };
}

async function channel(options: Parameters<typeof daemon>[0] = {}) {
  const fixture = await daemon(options);
  const notes: string[] = [];
  const push = await openCodexPush<string>({
    target: fixture.target,
    timeoutMs: options.delivery === "timeout" ? 200 : 2000,
    render: (items, since, cursor) =>
      `${items.join("\n")}\nsince: ${since}\ncursor: ${cursor}`,
    note: (line) => notes.push(line),
  });
  cleanups.push(push.close);
  return { ...fixture, push, notes };
}

describe("Codex existing App Server transport", () => {
  it("flushes a batch still being debounced before re-raising SIGTERM", async () => {
    const { target, requests } = await daemon();
    const clock = virtualClock();
    const emitted: unknown[] = [];
    const item = { created_at: clock.iso() };
    const follow = await openFollow<typeof item>({
      transport: "codex",
      label: "watch",
      subject: "todou",
      following: "todou",
      baseline: "c0",
      intervalSec: 2,
      wait: async () => {
        process.emit("SIGTERM", "SIGTERM");
      },
      render: () => "pending",
      emit: (items, since, cursor) => emitted.push({ items, since, cursor }),
      messaging: { codex: target },
      session: () => THREAD,
      clock,
      note: () => {},
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      await runWatchLoop({
        poll: false,
        forever: true,
        timeoutSec: 300,
        intervalSec: 2,
        debounceSec: 60,
        baseline: "c0",
        clock,
        signal: follow.signal,
        wait: follow.wait,
        shouldStop: follow.shouldStop,
        afterItems: follow.afterItems,
        onStop: follow.stopped,
        drain: async () => ({ items: [item], cursor: "c1" }),
        onItems: () => {},
        onEmpty: () => {},
      });
      follow.finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(emitted).toEqual([{ items: [item], since: "c0", cursor: "c1" }]);
      expect(requests.filter((r) => r.method === "turn/start")).toEqual([]);
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    } finally {
      follow.finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      kill.mockRestore();
    }
  });

  it.each(["project", "issue"])(
    "wires the %s watch to Codex and preserves the self filter",
    async (scope) => {
      const { target, requests } = await daemon();
      const clock = virtualClock();
      const sse = sseStub();
      let page = 0;
      const endpoint =
        scope === "project"
          ? "/api/projects/todou/activity"
          : "/api/projects/todou/issues/3/timeline";
      const { fetchImpl, calls } = fakeFetch([
        ["GET", "/api/me", { id: 2, login: "codex-agent", kind: "machine" }],
        ["GET", "/api/events", () => sse.reply()],
        [
          "GET",
          endpoint,
          () => {
            page++;
            if (page > 2)
              return {
                __status: 404,
                body: { code: "not_found", message: "gone" },
              };
            return {
              items:
                page === 1
                  ? [
                      {
                        type: "comment",
                        id: 9,
                        issue_number: 3,
                        body: "review ready",
                        author: {
                          id: 5,
                          login: "user",
                          display_name: "User",
                          kind: "human",
                        },
                        created_at: clock.iso(),
                        edited_at: null,
                      },
                    ]
                  : [],
              next_cursor: page === 1 ? "c1" : null,
            };
          },
        ],
      ]);
      const result = await runCli(
        [
          ...(scope === "project" ? ["watch"] : ["issue", "watch", "3"]),
          "-p",
          "todou",
          "--follow=codex",
          "--since",
          "c0",
          "--debounce",
          "0",
        ],
        {
          fetchImpl,
          clock,
          env: {
            ...loggedInEnv("todou"),
            CODEX_THREAD_ID: THREAD,
            TODOU_CODEX_SOCKET: target.socket,
          },
        },
      );
      expect(result.exitCode).toBe(1); // Scripted tracker shutdown after delivery.
      expect(result.stdout).toBe("cursor: c1\n");
      expect(result.stderr).toContain("--follow=codex following");
      const delivered = requests.filter((r) => r.method === "turn/start");
      expect(delivered).toHaveLength(1);
      expect(JSON.stringify(delivered[0].params.toolOutput)).toContain(
        "review ready",
      );
      expect(calls.filter((c) => c.url.includes(endpoint))[0].url).toContain(
        THREAD,
      );
    },
  );

  it("reports Codex availability through the agent command", async () => {
    const { target } = await daemon();
    const result = await runCli(["agent", "can-i-follow"], {
      env: { CODEX_THREAD_ID: THREAD, TODOU_CODEX_SOCKET: target.socket },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--follow=codex");
    expect(result.stdout).toContain("existing App conversation");
  });

  it.each(["active", "idle"])(
    "delivers to the same %s thread without changing its policy",
    async (state) => {
      const { push, requests, extensions } = await channel({ state });
      await push.send(["review approved"], "c0", "c1");
      expect(requests.map((r) => r.method)).toEqual([
        "initialize",
        "thread/read",
        "thread/resume",
        "turn/start",
      ]);
      expect(extensions).toEqual([undefined]);
      expect(requests[2].params).toEqual({
        threadId: THREAD,
        excludeTurns: true,
      });
      expect(requests[3].params).toEqual({
        threadId: THREAD,
        input: [],
        toolOutput: {
          name: "todou_watch",
          output: expect.stringContaining(
            "review approved\nsince: c0\ncursor: c1",
          ),
        },
      });
      expect(push.rejected).toBeNull();
      expect(push.unconfirmed().items).toEqual([]);
    },
  );

  it.each(["notLoaded", "systemError", "unknown"])(
    "refuses a %s thread instead of starting another session",
    async (state) => {
      const { target, requests } = await daemon({ state });
      await expect(openCodexPush({ target, render: () => "" })).rejects.toThrow(
        "not loaded",
      );
      expect(requests.map((r) => r.method)).toEqual([
        "initialize",
        "thread/read",
      ]);
    },
  );

  it("refuses an identity mismatch", async () => {
    const { target } = await daemon({ identity: "sibling-thread" });
    await expect(openCodexPush({ target, render: () => "" })).rejects.toThrow(
      "not loaded",
    );
  });

  it.each(["reject", "drop", "timeout", "invalid"] as const)(
    "retains a batch after %s and never resends it automatically",
    async (delivery) => {
      const { push, requests } = await channel({ delivery });
      await push.send(["answer"], "c0", "c1");
      await push.whenRejected;
      expect(push.unconfirmed()).toEqual({
        items: ["answer"],
        since: "c0",
        cursor: "c1",
      });
      expect(push.rejected?.reason).not.toContain("private input");
      await push.send(["another"], "c1", "c2");
      expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
      expect(push.unconfirmed().items).toEqual(["answer", "another"]);
    },
  );

  it("ignores sibling notifications and leaves approvals to the App", async () => {
    const { push, server, clientResponses, notes } = await channel();
    for (const client of server.clients) {
      client.send(
        JSON.stringify({
          method: "thread/archived",
          params: { threadId: "sibling" },
        }),
      );
      client.send(
        JSON.stringify({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: THREAD },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(push.rejected).toBeNull();
    expect(clientResponses).toEqual([]);
    expect(notes).toEqual([
      "Codex requests user interaction; answer in the connected App",
    ]);
    for (const client of server.clients) {
      client.send(
        JSON.stringify({
          method: "thread/archived",
          params: { threadId: THREAD },
        }),
      );
    }
    await push.whenRejected;
    expect(push.rejected?.reason).toContain("closed or archived");
  });

  it("bounds an oversized batch while preserving its recovery range", async () => {
    const { push, requests } = await channel();
    await push.send(["界".repeat(100_000)], "c0", "c1");
    const last = requests.at(-1);
    if (!last) throw new Error("missing delivery request");
    const output = (last.params.toolOutput as { output: string }).output;
    expect(Buffer.byteLength(output)).toBeLessThan(1000);
    expect(output).toContain("since: c0\ncursor: c1");
  });

  it("flushes undelivered events and cursor through the shared follow contract", async () => {
    const { target } = await daemon({ delivery: "reject" });
    const emitted: unknown[] = [];
    const notes: string[] = [];
    const before = process.listenerCount("SIGTERM");
    const follow = await openFollow<string>({
      transport: "codex",
      label: "todou issue watch 3",
      subject: "3",
      following: "T-3",
      baseline: "c0",
      intervalSec: 2,
      wait: undefined,
      render: (items) => items.join("\n"),
      emit: (items, since, cursor) => emitted.push({ items, since, cursor }),
      messaging: { codex: target },
      session: () => THREAD,
      clock: virtualClock(),
      note: (line) => notes.push(line),
    });
    cleanups.push(follow.finish);
    expect(follow.silent).toBe(true);
    expect(await follow.afterItems?.(["answer"], "c1")).toBe("stop");
    follow.finish();
    follow.finish();
    expect(emitted).toEqual([{ items: ["answer"], since: "c0", cursor: "c1" }]);
    expect(notes.join("\n")).toContain("--follow=codex stopped");
    expect(notes.join("\n")).not.toContain("crossSessionInbound");
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("requires a thread plus a real local socket and never borrows Claude messaging", async () => {
    const { target } = await daemon();
    const env = { CODEX_THREAD_ID: THREAD, TODOU_CODEX_SOCKET: target.socket };
    expect(codexTarget(env)).toEqual(target);
    expect(
      harnessMessaging({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: "/wrong.sock" }),
    ).toEqual({ codex: target });
    expect(
      codexTarget({ ...env, CODEX_THREAD_ID: "../thread" }),
    ).toBeUndefined();
    expect(
      codexTarget({ ...env, TODOU_CODEX_SOCKET: "relative.sock" }),
    ).toBeUndefined();
    expect(codexTarget({ TODOU_CODEX_SOCKET: target.socket })).toBeUndefined();
    const file = join(target.socket, "..", "ordinary-file");
    writeFileSync(file, "not a socket");
    expect(codexTarget({ ...env, TODOU_CODEX_SOCKET: file })).toBeUndefined();
    expect(
      followTransport({
        raw: "codex",
        poll: false,
        socket: undefined,
        codex: target,
      }),
    ).toBe("codex");
    expect(() =>
      followTransport({ raw: "codex", poll: false, socket: undefined }),
    ).toThrow("no Codex thread");
    expect(() =>
      followTransport({
        raw: "codex",
        poll: true,
        socket: undefined,
        codex: target,
      }),
    ).toThrow("conflicts");
  });
});
