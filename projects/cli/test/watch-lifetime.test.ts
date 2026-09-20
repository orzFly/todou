import { TodouNetworkError } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../src/clock.ts";
import type { NativeWatchOwner } from "../src/harness/messaging.ts";
import { openFollow } from "../src/watch-follow.ts";
import { openWatchLifetime } from "../src/watch-lifetime.ts";
import { retryTransient, runWatchLoop } from "../src/watch-loop.ts";
import { fakePeerPush } from "./fake-peer-push.ts";

const owner: NativeWatchOwner = {
  peer: "omp",
  pid: 123,
  path: "/fixture/123.json",
  sessionId: "session-one",
  socket: "/fixture/123.sock",
  token: "fixture-token-one",
};

afterEach(() => vi.useRealTimers());

describe("native raw watch lifetime", () => {
  it.each([
    { sessionId: "session-two" },
    { token: "fixture-token-two" },
    { pid: 456 },
    { path: "/fixture/456.json" },
    { socket: "/fixture/456.sock" },
    { peer: "pi" as const },
    undefined,
  ])("independently notices changed identity %j while idle", async (change) => {
    vi.useFakeTimers();
    let live: NativeWatchOwner | undefined = { ...owner };
    const note = vi.fn();
    const lifetime = openWatchLifetime({
      env: {},
      readOwner: () => live,
      note,
    });
    try {
      expect(lifetime).toBeDefined();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(lifetime?.signal.aborted).toBe(false);
      // Mutate in place to prove the original snapshot really was copied.
      if (change === undefined) live = undefined;
      else Object.assign(live as NativeWatchOwner, change);
      const sleeping = lifetime?.clock.sleep(3_600_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await sleeping;
      expect(lifetime?.signal.aborted).toBe(true);
      expect(note).toHaveBeenCalledOnce();
      expect(note.mock.calls.flat().join(" ")).not.toContain(owner.token);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lifetime?.close();
    }
  });

  it("does not adopt an owner that appears after startup", () => {
    vi.useFakeTimers();
    const readOwner = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValue(owner);
    expect(
      openWatchLifetime({ env: {}, readOwner, note: vi.fn() }),
    ).toBeUndefined();
    expect(readOwner).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes its independent check and outstanding sleeps on normal completion", async () => {
    vi.useFakeTimers();
    const lifetime = openWatchLifetime({
      env: {},
      readOwner: () => owner,
      note: vi.fn(),
    });
    const sleeping = lifetime?.clock.sleep(3_600_000);
    lifetime?.close();
    await sleeping;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an infinite retry budget without another request or a surviving timer", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const request = vi.fn(async () => {
      throw new TodouNetworkError("fixture outage");
    });
    const result = retryTransient(request, {
      maxAttempts: Number.POSITIVE_INFINITY,
      baseDelayMs: 30_000,
      maxDelayMs: 30_000,
      signal: abort.signal,
      random: () => 1,
    });
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await rejected;
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes a debounce batch and its cursor without pushing to the retired owner", async () => {
    const abort = new AbortController();
    const push = fakePeerPush();
    const emit = vi.fn();
    const follow = await openFollow<{ created_at: string; body: string }>({
      transport: "uds",
      label: "todou watch -p fixture",
      subject: "fixture",
      following: "fixture",
      baseline: "c0",
      intervalSec: 3_600,
      wait: async () => abort.abort(),
      render: (items) => items.map((item) => item.body).join("\n"),
      emit,
      messaging: owner,
      session: () => owner.sessionId,
      clock: systemClock,
      signal: abort.signal,
      note: () => {},
      open: push.open,
    });
    const item = {
      created_at: new Date().toISOString(),
      body: "collected entry",
    };
    const drain = vi.fn(async () => ({ items: [item], cursor: "c1" }));
    try {
      expect(
        await runWatchLoop({
          poll: false,
          forever: true,
          timeoutSec: 3_600,
          intervalSec: 3_600,
          debounceSec: 3_600,
          baseline: "c0",
          drain,
          onItems: () => {},
          onEmpty: () => {},
          afterItems: follow.afterItems,
          wait: follow.wait,
          signal: abort.signal,
          onStop: follow.stopped,
        }),
      ).toBe(0);
    } finally {
      follow.finish();
    }
    expect(drain).toHaveBeenCalledOnce();
    expect(push.pushes).toEqual([]);
    expect(emit).toHaveBeenCalledExactlyOnceWith([item], "c0", "c1");
    expect(push.closed()).toBe(true);
  });
});
