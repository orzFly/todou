import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexTarget,
  openCodex,
  openCodexQueuePush,
  type QueueRunner,
} from "../src/codex-push.ts";
import { followAdvice } from "../src/follow-advice.ts";
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

describe("Codex watch delivery", () => {
  it("flushes a batch still being debounced before re-raising SIGTERM", async () => {
    const { bin, calls: requests } = codexOnPath();
    const target = { threadId: THREAD, bin };
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
      expect(requests()).toEqual([]);
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
      const { bin, calls: requests } = codexOnPath();
      const target = { threadId: THREAD, bin };
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
            TODOU_CODEX_BIN: target.bin,
          },
        },
      );
      expect(result.exitCode).toBe(1); // Scripted tracker shutdown after delivery.
      expect(result.stdout).toBe("cursor: c1\n");
      expect(result.stderr).toContain("--follow=codex following");
      const delivered = requests();
      expect(delivered).toHaveLength(1);
      expect(JSON.stringify(delivered[0])).toContain("review ready");
      expect(calls.filter((c) => c.url.includes(endpoint))[0].url).toContain(
        THREAD,
      );
    },
  );

  it("flushes undelivered events and cursor through the shared follow contract", async () => {
    const { bin } = codexOnPath();
    const target = { threadId: THREAD, bin };
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
      runCodexQueue: async () => {
        throw new Error("queue unavailable");
      },
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

  it("wakes a quiet follow when cancelled instead of waiting for another tracker event", async () => {
    const stop = new AbortController();
    const follow = await openFollow<string>({
      transport: "codex",
      label: "watch",
      subject: "todou",
      following: "todou",
      baseline: "c0",
      intervalSec: 2,
      signal: stop.signal,
      wait: () => new Promise<void>(() => {}),
      render,
      emit: () => {},
      messaging: { codex: { threadId: THREAD, bin: "/opt/codex" } },
      session: () => THREAD,
      clock: virtualClock(),
      note: () => {},
    });
    cleanups.push(follow.finish);
    const waiting = follow.wait!(600_000);
    stop.abort();
    await waiting;
    expect(follow.shouldStop?.()).toBe(true);
  });

  it("requires an executable and explicit thread; never borrows Claude or socket-only delivery", () => {
    const { bin } = codexOnPath();
    const env = { CODEX_THREAD_ID: THREAD, TODOU_CODEX_BIN: bin };
    const target = { threadId: THREAD, bin };
    expect(codexTarget(env)).toEqual(target);
    expect(
      harnessMessaging({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: "/wrong.sock" }),
    ).toEqual({ codex: target });
    expect(
      codexTarget({ ...env, CODEX_THREAD_ID: "../thread" }),
    ).toBeUndefined();
    expect(codexTarget({ TODOU_CODEX_BIN: bin })).toBeUndefined();
    expect(
      codexTarget({
        CODEX_THREAD_ID: THREAD,
        TODOU_CODEX_SOCKET: "/run/control.sock",
      }),
    ).toBeUndefined();
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

/** A directory holding an executable `codex`, for PATH lookups. */
function codexOnPath() {
  const dir = mkdtempSync(join(tmpdir(), "todou-codex-bin-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "codex");
  const log = join(dir, "queue.jsonl");
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!${process.execPath}
import * as fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('Queued message test-batch for thread ${THREAD}.');
`,
  );
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    calls: (): string[][] =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

/** Records every `codex queue` call and answers like the real command. */
function queueRunner(answer: (message: string) => Promise<string> | string) {
  const calls: string[][] = [];
  const run: QueueRunner = async (bin, args) => {
    calls.push([bin, ...args]);
    return answer(args[args.length - 1] ?? "");
  };
  return { calls, run };
}

const QUEUED = `Queued message 01a15f6f-d4db-7650-b4ba-9c3ef8f54983 for thread ${THREAD}.\n`;
const render = (items: string[], since?: string, cursor?: string) =>
  `${items.join("\n")}\nsince: ${since}\ncursor: ${cursor}`;

describe("Codex queue transport", () => {
  it("finds codex on PATH, skipping relative and non-executable entries", () => {
    const { dir, bin } = codexOnPath();
    const plain = mkdtempSync(join(tmpdir(), "todou-codex-plain-"));
    cleanups.push(() => rmSync(plain, { recursive: true, force: true }));
    writeFileSync(join(plain, "codex"), "not executable");
    const env = {
      CODEX_THREAD_ID: THREAD,
      HOME: "/nonexistent-todou-home",
      PATH: ["relative", plain, dir].join(":"),
    };
    expect(codexTarget(env)).toEqual({ threadId: THREAD, bin });
    expect(codexTarget({ ...env, PATH: plain })).toBeUndefined();
    expect(codexTarget({ ...env, PATH: "relative" })).toBeUndefined();
    expect(codexTarget({ ...env, PATH: "", TODOU_CODEX_BIN: bin })).toEqual({
      threadId: THREAD,
      bin,
    });
    expect(codexTarget({ ...env, TODOU_CODEX_BIN: "codex" })).toBeUndefined();
    expect(codexTarget({ ...env, CODEX_THREAD_ID: "../t" })).toBeUndefined();
  });

  it("uses the queue even when an App socket is configured", async () => {
    const { bin } = codexOnPath();
    const target = codexTarget({
      CODEX_THREAD_ID: THREAD,
      TODOU_CODEX_SOCKET: "/run/control.sock",
      TODOU_CODEX_BIN: bin,
    });
    expect(target).toEqual({ threadId: THREAD, bin });
    const { calls, run } = queueRunner(() => QUEUED);
    const push = await openCodex({ target: target!, render, run });
    await push.send(["next card"], "c0", "c1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("queue");
  });

  it("queues each batch for this thread and confirms on Codex's receipt", async () => {
    const { calls, run } = queueRunner(() => QUEUED);
    const push = openCodexQueuePush<string>({
      threadId: THREAD,
      bin: "/opt/codex",
      render,
      run,
    });
    await push.send(["review approved"], "c0", "c1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 5)).toEqual([
      "/opt/codex",
      "queue",
      "--thread",
      THREAD,
      "--message",
    ]);
    expect(calls[0]?.[5]).toContain("Tracker activity follows.");
    expect(calls[0]?.[5]).toContain("review approved\nsince: c0\ncursor: c1");
    expect(push.rejected).toBeNull();
    expect(push.unconfirmed().items).toEqual([]);
  });

  it.each([
    ["an unconfirmed answer", () => "something else\n"],
    [
      "a receipt for another thread",
      () => "Queued message test for thread sibling.\n",
    ],
    [
      "a failing command",
      () => {
        throw Object.assign(new Error("secret batch text"), { code: 1 });
      },
    ],
  ])("stops on %s and keeps the whole range", async (_, answer) => {
    const { calls, run } = queueRunner(answer);
    const push = openCodexQueuePush<string>({
      threadId: THREAD,
      bin: "/opt/codex",
      render,
      run,
    });
    await push.send(["one"], "c0", "c1");
    expect(push.rejected?.status).toBe("unreachable");
    expect(push.rejected?.reason).not.toContain("secret");
    await push.whenRejected;
    await push.send(["two"], "c1", "c2");
    expect(calls).toHaveLength(1);
    expect(push.unconfirmed()).toEqual({
      items: ["one", "two"],
      since: "c0",
      cursor: "c2",
    });
  });

  it("retains in-flight admission on cancellation, even if a late receipt arrives", async () => {
    const stop = new AbortController();
    let complete!: (value: string) => void;
    const run: QueueRunner = async (_bin, _args, signal) => {
      expect(signal).toBe(stop.signal);
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    };
    const push = openCodexQueuePush({
      threadId: THREAD,
      bin: "/opt/codex",
      render,
      run,
      signal: stop.signal,
    });
    cleanups.push(push.close);
    const sending = push.send(["answer"], "c0", "c1");
    stop.abort();
    await push.whenRejected;
    complete(QUEUED);
    await sending;
    expect(push.unconfirmed()).toEqual({
      items: ["answer"],
      since: "c0",
      cursor: "c1",
    });
  });

  it("keeps an oversized batch under the argv limit with its recovery range", async () => {
    const { calls, run } = queueRunner(() => QUEUED);
    const push = openCodexQueuePush<string>({
      threadId: THREAD,
      bin: "/opt/codex",
      render,
      run,
    });
    await push.send(["界".repeat(100_000)], "c0", "c1");
    const message = calls[0]?.[5] ?? "";
    expect(Buffer.byteLength(message)).toBeLessThan(128 * 1024);
    expect(message).toContain("since: c0\ncursor: c1");
  });

  it("delivers through openFollow and names the channel it chose", async () => {
    const { calls, run } = queueRunner(() => QUEUED);
    const notes: string[] = [];
    const follow = await openFollow<string>({
      transport: "codex",
      label: "todou issue watch 3",
      subject: "3",
      following: "T-3",
      baseline: "c0",
      intervalSec: 2,
      wait: undefined,
      render: (items) => items.join("\n"),
      emit: () => {},
      messaging: { codex: { threadId: THREAD, bin: "/opt/codex" } },
      session: () => THREAD,
      clock: virtualClock(),
      note: (line) => notes.push(line),
      runCodexQueue: run,
    });
    cleanups.push(follow.finish);
    expect(follow.silent).toBe(true);
    expect(await follow.afterItems?.(["answer"], "c1")).toBe("continue");
    expect(calls).toHaveLength(1);
    expect(notes.join("\n")).toContain("via codex queue");
  });

  it("advises the queue where there is no socket, and poll where there is neither", async () => {
    const { dir } = codexOnPath();
    const queued = await runCli(["agent", "can-i-follow"], {
      env: { CODEX_THREAD_ID: THREAD, PATH: dir },
    });
    expect(queued.exitCode).toBe(0);
    expect(queued.stdout).toContain("`codex queue`");
    expect(queued.stdout).toContain("exec_command");
    expect(
      followAdvice({
        harness: "codex",
        codex: { threadId: THREAD, bin: "/opt/codex" },
        socket: undefined,
        optedOut: false,
      }).situation,
    ).toBe("codex-queue");
    const none = await runCli(["agent", "can-i-follow"], {
      env: { CODEX_THREAD_ID: THREAD, PATH: "" },
    });
    expect(none.stdout).toContain("poll mode");
    expect(none.stdout).not.toContain("--follow=codex");
  });
});
