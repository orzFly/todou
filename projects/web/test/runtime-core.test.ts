// @vitest-environment node
import { TodouError } from "@todou/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletedCache, payloadBytes } from "../src/api/runtime/cache.ts";
import {
  defineProjection,
  type ProjectionDescriptor,
} from "../src/api/runtime/projections.ts";
import {
  type RuntimeSnapshot,
  validateClientMessage,
} from "../src/api/runtime/protocol.ts";
import {
  networkResource,
  type ResourceDescriptor,
  resource,
  resourceId,
} from "../src/api/runtime/resources.ts";
import {
  ResourceRuntime,
  type ResourceRuntimeOptions,
} from "../src/api/runtime/runtime.ts";
import {
  EmptySnapshotStore,
  type SnapshotRecord,
  type SnapshotStore,
  type StoreGuard,
} from "../src/api/runtime/store.ts";

interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const issue = resource("issue", "/projects/example/issues/1");
const otherIssue = resource("issue", "/projects/example/issues/2");
const projection = (descriptor = issue): ProjectionDescriptor =>
  defineProjection({
    kind: "direct",
    version: 1,
    queryKey: ["issue", "example", descriptor === issue ? 1 : 2],
    queryHash: descriptor.path,
    resources: [descriptor],
  });
const runtimes: ResourceRuntime[] = [];
function harness(options: Omit<ResourceRuntimeOptions, "network"> = {}) {
  const requests: Array<{
    resource: ResourceDescriptor;
    signal: AbortSignal;
    pending: Deferred;
  }> = [];
  const network = vi.fn(
    (descriptor: ResourceDescriptor, signal: AbortSignal) => {
      const pending = deferred();
      requests.push({ resource: descriptor, signal, pending });
      return pending.promise;
    },
  );
  const runtime = new ResourceRuntime({ network, ...options });
  runtimes.push(runtime);
  return { runtime, network, requests };
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  vi.useRealTimers();
});

describe("completed values, SWR and generation barriers", () => {
  it("shares cold reads, serves completed fresh values, and coalesces explicit fresh reads", async () => {
    const { runtime, network, requests } = harness();
    const first = runtime.read(issue);
    const second = runtime.read(issue);
    expect(network).toHaveBeenCalledTimes(1);
    requests[0]!.pending.resolve({ title: "one" });
    await expect(first).resolves.toEqual({ title: "one" });
    await expect(second).resolves.toEqual({ title: "one" });
    await flush();
    await expect(runtime.read(issue)).resolves.toEqual({ title: "one" });
    expect(network).toHaveBeenCalledTimes(1);
    const freshA = runtime.read(issue, { forceFresh: true });
    const freshB = runtime.read(issue, { forceFresh: true });
    expect(network).toHaveBeenCalledTimes(2);
    requests[1]!.pending.resolve({ title: "two" });
    await expect(freshA).resolves.toEqual({ title: "two" });
    await expect(freshB).resolves.toEqual({ title: "two" });
  });

  it("honors stricter read freshness without extending policy or duplicating an in-flight read", async () => {
    const { runtime, requests } = harness();
    const first = runtime.read(issue);
    requests[0]!.pending.resolve("seed");
    await first;
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(runtime.read(issue, { freshnessMs: 2_000 })).resolves.toBe(
      "seed",
    );
    const stricter = runtime.read(issue, { freshnessMs: 500 });
    const zero = runtime.read(issue, { freshnessMs: 0 });
    expect(requests).toHaveLength(2);
    requests[1]!.pending.resolve("fresh");
    await expect(stricter).resolves.toBe("fresh");
    await expect(zero).resolves.toBe("fresh");
    await flush();
    const immediate = runtime.readProjection(projection(), { freshnessMs: 0 });
    expect(requests).toHaveLength(3);
    requests[2]!.pending.resolve("immediate");
    await expect(immediate).resolves.toBe("immediate");
    await flush();
    await vi.advanceTimersByTimeAsync(5_001);
    const registryBound = runtime.read(issue, { freshnessMs: 60_000 });
    expect(requests).toHaveLength(4);
    requests[3]!.pending.resolve("registry bound");
    await registryBound;
    await expect(
      runtime.read(issue, { freshnessMs: -1 }),
    ).rejects.toMatchObject({ kind: "protocol" });
    await expect(
      runtime.read(issue, { freshnessMs: Number.POSITIVE_INFINITY }),
    ).rejects.toMatchObject({ kind: "protocol" });
  });

  it("uses minimum enabled observer freshness and settles zero-age subscriptions without a loop", async () => {
    const { runtime, requests } = harness();
    const first = runtime.read(issue);
    requests[0]!.pending.resolve("seed");
    await first;
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    const listener = vi.fn();
    runtime.subscribe(
      "disabled",
      projection(),
      { enabled: false, visible: true, freshnessMs: 0 },
      listener,
    );
    runtime.subscribe(
      "normal",
      projection(),
      { enabled: true, visible: true, freshnessMs: 2_000 },
      listener,
    );
    expect(requests).toHaveLength(1);
    runtime.subscribe(
      "strict",
      projection(),
      { enabled: true, visible: true, freshnessMs: 500 },
      listener,
    );
    expect(requests).toHaveLength(2);
    requests[1]!.pending.resolve("strict result");
    await flush();
    runtime.subscribe(
      "zero",
      projection(),
      { enabled: true, visible: true, freshnessMs: 0 },
      listener,
    );
    expect(requests).toHaveLength(3);
    requests[2]!.pending.resolve("zero result");
    await flush();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: "zero result",
        fetchStatus: "idle",
        stale: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests).toHaveLength(3);
  });

  it("publishes warm stale/fetching then atomically updates two ports", async () => {
    const { runtime, requests, network } = harness();
    const seed = runtime.read(issue);
    requests[0]!.pending.resolve({ title: "warm" });
    await seed;
    await vi.advanceTimersByTimeAsync(5_001);
    const a: RuntimeSnapshot[] = [];
    const b: RuntimeSnapshot[] = [];
    runtime.subscribe(
      "a:issue",
      projection(),
      { enabled: true, visible: true },
      (snapshot) => a.push(snapshot),
    );
    runtime.subscribe(
      "b:issue",
      projection(),
      { enabled: true, visible: true },
      (snapshot) => b.push(snapshot),
    );
    expect(a[0]).toMatchObject({ data: { title: "warm" }, stale: true });
    expect(a.at(-1)).toMatchObject({
      data: { title: "warm" },
      fetchStatus: "fetching",
    });
    expect(network).toHaveBeenCalledTimes(2);
    requests[1]!.pending.resolve({ title: "fresh" });
    await flush();
    expect(a.at(-1)).toMatchObject({
      data: { title: "fresh" },
      stale: false,
      fetchStatus: "idle",
    });
    expect(b.at(-1)).toMatchObject({ data: { title: "fresh" }, stale: false });
  });

  it("an older in-flight completion cannot satisfy a newer generation waiter", async () => {
    const { runtime, requests, network } = harness();
    const old = runtime.read(issue);
    await runtime.invalidate([{ type: "resource", resource: issue }], {
      refetchType: "none",
    });
    let delivered = false;
    const fresh = runtime.read(issue).then((value) => {
      delivered = true;
      return value;
    });
    requests[0]!.pending.resolve("old");
    await expect(old).resolves.toBe("old");
    await flush();
    expect(delivered).toBe(false);
    expect(runtime.peek(issue)?.stale).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
    requests[1]!.pending.resolve("new");
    await expect(fresh).resolves.toBe("new");
    expect(runtime.peek(issue)?.stale).toBe(false);
  });

  it("many invalidations during one request produce only one sequential follow-up", async () => {
    const { runtime, network, requests } = harness();
    const initial = runtime.read(issue);
    for (let index = 0; index < 30; index++)
      await runtime.invalidate(
        [{ type: "issue", slug: "example", number: 1 }],
        { refetchType: "none" },
      );
    const latest = runtime.read(issue);
    expect(network).toHaveBeenCalledTimes(1);
    requests[0]!.pending.resolve("before");
    await initial;
    await flush();
    expect(network).toHaveBeenCalledTimes(2);
    requests[1]!.pending.resolve("after");
    await expect(latest).resolves.toBe("after");
    await flush();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("invalidation before a read and after completion both force the next read", async () => {
    const { runtime, requests } = harness();
    await runtime.invalidate([{ type: "issue", slug: "example", number: 1 }], {
      refetchType: "none",
    });
    const first = runtime.read(issue);
    requests[0]!.pending.resolve(1);
    await first;
    await flush();
    await runtime.invalidate([{ type: "issue", slug: "example", number: 1 }], {
      refetchType: "none",
    });
    const second = runtime.read(issue);
    expect(requests).toHaveLength(2);
    requests[1]!.pending.resolve(2);
    await expect(second).resolves.toBe(2);
  });

  it("dirty-only invalidation during a subscription flight does not start a follow-up", async () => {
    const { runtime, requests, network } = harness();
    const frames: RuntimeSnapshot[] = [];
    runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      (snapshot) => frames.push(snapshot),
    );
    await runtime.invalidate([{ type: "key-prefix", queryKey: ["issue"] }], {
      refetchType: "none",
    });
    requests[0]!.pending.resolve("old");
    await flush();
    expect(network).toHaveBeenCalledTimes(1);
    expect(frames.at(-1)).toMatchObject({
      data: "old",
      stale: true,
      fetchStatus: "idle",
    });
    const fresh = runtime.read(issue);
    expect(network).toHaveBeenCalledTimes(2);
    requests[1]!.pending.resolve("new");
    await fresh;
  });

  it("ACK dirty application precedes and is distinct from selected-read completion", async () => {
    const { runtime, requests } = harness();
    runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      () => {},
    );
    requests[0]!.pending.resolve("seed");
    await flush();
    const applied = vi.fn();
    let completed = false;
    const control = runtime
      .invalidate([{ type: "key-prefix", queryKey: ["issue"] }], {
        operationId: "refresh-1",
        completion: "reads-settled",
        onApplied: applied,
      })
      .then(() => {
        completed = true;
      });
    expect(applied).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    expect(requests).toHaveLength(2);
    const again = runtime.invalidate([{ type: "user" }], {
      operationId: "refresh-1",
      completion: "reads-settled",
    });
    expect(requests).toHaveLength(2);
    requests[1]!.pending.resolve("fresh");
    await Promise.all([control, again]);
    expect(completed).toBe(true);
  });

  it("retains imperative descriptor mappings for prefix invalidation and CacheView", async () => {
    const { runtime, requests } = harness();
    const first = runtime.readProjection(projection());
    requests[0]!.pending.resolve({ number: 1 });
    await first;
    await flush();
    expect(runtime.cacheView.getQueryData(["issue", "example", 1])).toEqual({
      number: 1,
    });
    await runtime.invalidate(
      [{ type: "key-prefix", queryKey: ["issue", "example"] }],
      { refetchType: "none" },
    );
    const next = runtime.readProjection(projection());
    expect(requests).toHaveLength(2);
    requests[1]!.pending.resolve({ number: 1, changed: true });
    await expect(next).resolves.toEqual({ number: 1, changed: true });
  });

  it("keeps a same-id subscription update alive while a request is pending", async () => {
    const { runtime, requests } = harness();
    const old = vi.fn();
    const next = vi.fn();
    const unsubscribeOld = runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      old,
    );
    runtime.subscribe(
      "a",
      projection(),
      { enabled: false, visible: false },
      next,
    );
    runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      next,
    );
    unsubscribeOld();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    requests[0]!.pending.resolve("done");
    await flush();
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: "done", fetchStatus: "idle" }),
    );
    expect(runtime.stats.subscriptions).toBe(1);
  });

  it("hidden consumers receive another port's result without issuing reads", async () => {
    const { runtime, requests } = harness();
    const hidden = vi.fn();
    runtime.subscribe(
      "hidden",
      projection(),
      { enabled: true, visible: false },
      hidden,
    );
    expect(requests).toHaveLength(0);
    const active = runtime.read(issue);
    requests[0]!.pending.resolve("visible result");
    await active;
    await flush();
    expect(requests).toHaveLength(1);
    expect(hidden).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: "visible result" }),
    );
  });

  it("selects only requested projections and deduplicates event sequence echoes", async () => {
    const { runtime, requests } = harness();
    runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      () => {},
    );
    runtime.subscribe(
      "b",
      projection(otherIssue),
      { enabled: true, visible: true },
      () => {},
    );
    requests[0]!.pending.resolve("one");
    requests[1]!.pending.resolve("two");
    await flush();
    const selected = runtime.invalidate(
      [{ type: "project", slug: "example" }],
      { selection: [projection().queryHash], eventSeq: 8 },
    );
    expect(requests).toHaveLength(3);
    const generation = runtime.getGeneration(issue);
    requests[2]!.pending.resolve("changed");
    await selected;
    await runtime.invalidate([{ type: "project", slug: "example" }], {
      selection: [projection().queryHash],
      eventSeq: 8,
    });
    expect(runtime.getGeneration(issue)).toBe(generation);
    expect(requests).toHaveLength(3);
    expect(runtime.peek(otherIssue)?.stale).toBe(true);
  });
});

describe("cancellation, timeout and retry ownership", () => {
  it("cancelling one waiter does not cancel another consumer", async () => {
    const { runtime, requests } = harness();
    const controller = new AbortController();
    const a = runtime.read(issue, { signal: controller.signal });
    const cancelled = expect(a).rejects.toMatchObject({ name: "AbortError" });
    const b = runtime.read(issue);
    controller.abort();
    await cancelled;
    expect(requests[0]!.signal.aborted).toBe(false);
    requests[0]!.pending.resolve("shared");
    await expect(b).resolves.toBe("shared");
    expect(runtime.stats.waiters).toBe(0);
  });

  it("cancelling all waiters aborts, abandons late data, and holds a stuck physical slot", async () => {
    const { runtime, requests } = harness();
    const controller = new AbortController();
    const a = runtime.read(issue, { signal: controller.signal });
    const cancelled = expect(a).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelled;
    expect(requests[0]!.signal.aborted).toBe(true);
    const b = runtime.read(issue);
    expect(requests).toHaveLength(1);
    requests[0]!.pending.resolve("abandoned");
    await flush();
    expect(runtime.peek(issue)).toBeUndefined();
    expect(requests).toHaveLength(2);
    requests[1]!.pending.resolve("current");
    await expect(b).resolves.toBe("current");
  });

  it("holds a cancelled batch item's physical slot while its sibling is still live", async () => {
    const physical = deferred<void>();
    const firstItem = deferred();
    const sibling = deferred();
    let issueReads = 0;
    const nextItem = deferred();
    const network = vi.fn(
      (descriptor: ResourceDescriptor, signal: AbortSignal) => {
        if (descriptor.path === otherIssue.path)
          return {
            promise: sibling.promise,
            transportSettled: physical.promise,
          };
        if (++issueReads === 1) {
          signal.addEventListener(
            "abort",
            () =>
              firstItem.reject(
                Object.assign(new Error("cancelled"), { name: "AbortError" }),
              ),
            { once: true },
          );
          return {
            promise: firstItem.promise,
            transportSettled: physical.promise,
          };
        }
        return nextItem.promise;
      },
    );
    const runtime = new ResourceRuntime({ network });
    runtimes.push(runtime);
    const controller = new AbortController();
    const cancelled = runtime.read(issue, { signal: controller.signal });
    const cancelledAssertion = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const liveSibling = runtime.read(otherIssue);
    controller.abort();
    await cancelledAssertion;
    await flush();
    const next = runtime.read(issue);
    await flush();
    expect(network).toHaveBeenCalledTimes(2);
    expect(runtime.stats.flights).toBe(2);
    sibling.resolve("sibling result");
    await expect(liveSibling).resolves.toBe("sibling result");
    await flush();
    expect(network).toHaveBeenCalledTimes(2);
    physical.resolve();
    await flush();
    expect(network).toHaveBeenCalledTimes(3);
    nextItem.resolve("replacement");
    await expect(next).resolves.toBe("replacement");
  });

  it("times out once and does not produce unbounded requests behind ignored aborts", async () => {
    const { runtime, requests } = harness();
    const result = runtime.read(issue);
    const rejected = expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(requests[0]!.signal.aborted).toBe(true);
    for (let index = 0; index < 3; index++) {
      const next = runtime.read(issue);
      const nextRejected = expect(next).rejects.toMatchObject({
        kind: "timeout",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await nextRejected;
    }
    expect(requests).toHaveLength(1);
    expect(runtime.stats.waiters).toBe(0);
    requests[0]!.pending.resolve("too late");
    await flush();
    expect(runtime.peek(issue)).toBeUndefined();
    expect(runtime.stats.flights).toBe(0);
  });

  it("pre-aborted reads never allocate a network request", async () => {
    const { runtime, network } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.read(issue, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(network).not.toHaveBeenCalled();
  });

  it("retries transient failures twice, never caches errors, and never retries 4xx", async () => {
    const { runtime, requests } = harness();
    const result = runtime.read(issue);
    const rejected = expect(result).rejects.toThrow("unavailable");
    requests[0]!.pending.reject(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(1_000);
    requests[1]!.pending.reject(new Error("unavailable"));
    await vi.advanceTimersByTimeAsync(2_000);
    requests[2]!.pending.reject(new Error("unavailable"));
    await rejected;
    await flush();
    expect(requests).toHaveLength(3);
    expect(runtime.peek(issue)).toBeUndefined();
    const forbidden = runtime.read(issue);
    const denied = expect(forbidden).rejects.toMatchObject({ status: 403 });
    requests[3]!.pending.reject(
      Object.assign(new Error("denied"), { status: 403 }),
    );
    await denied;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(4);
    expect(runtime.stats.waiters).toBe(0);
  });

  it("does not add runtime retries or completed cache to network-only and no-store reads", async () => {
    const { runtime, requests } = harness();
    for (const descriptor of [
      networkResource("/me"),
      resource("no-store", "/projects/example/activity-calendar"),
    ]) {
      const first = runtime.read(descriptor);
      const second = runtime.read(descriptor);
      const current = requests.at(-1)!;
      current.pending.resolve("private");
      await Promise.all([first, second]);
      await flush();
      expect(runtime.peek(descriptor)).toBeUndefined();
      const third = runtime.read(descriptor);
      const rejected = expect(third).rejects.toThrow("network");
      requests.at(-1)!.pending.reject(new Error("network"));
      await rejected;
      await vi.advanceTimersByTimeAsync(3_000);
    }
    expect(requests).toHaveLength(4);
  });

  it("preserves warm data on transient error but revokes it on permission failure", async () => {
    const { runtime, requests } = harness();
    const frames: RuntimeSnapshot[] = [];
    runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      (snapshot) => frames.push(snapshot),
    );
    requests[0]!.pending.resolve("warm");
    await flush();
    const failed = runtime.invalidate([{ type: "user" }], {
      throwOnError: true,
    });
    const rejected = expect(failed).rejects.toThrow("offline");
    for (let index = 0; index < 3; index++) {
      requests[index + 1]!.pending.reject(new Error("offline"));
      await vi.advanceTimersByTimeAsync(
        index === 0 ? 1_000 : index === 1 ? 2_000 : 0,
      );
    }
    await rejected;
    expect(frames.at(-1)).toMatchObject({
      status: "error",
      data: "warm",
      fetchStatus: "idle",
    });
    const denied = runtime.invalidate([{ type: "user" }]);
    requests[4]!.pending.reject(
      new TodouError(403, "forbidden", "forbidden", undefined, issue.path),
    );
    await denied;
    expect(frames.at(-1)).toMatchObject({
      status: "error",
      data: undefined,
      dropData: true,
    });
    expect(runtime.peek(issue)).toBeUndefined();
  });

  it("rejects old-epoch waiters and cannot resurrect their late completion", async () => {
    const { runtime, requests } = harness({
      accountEpoch: 1,
      accountId: "alice",
    });
    const old = runtime.read(issue);
    const rejected = expect(old).rejects.toMatchObject({
      kind: "session-reset",
    });
    runtime.setEpoch(2, "bob");
    await rejected;
    const fresh = runtime.read(issue);
    requests[1]!.pending.resolve("bob value");
    await fresh;
    requests[0]!.pending.resolve("alice late");
    await flush();
    expect(runtime.peek(issue)?.data).toBe("bob value");
  });
});

describe("bounded retention and store guards", () => {
  it("counts UTF-8 JSON bytes and evicts unpinned LRU before rejecting pinned capacity", () => {
    expect(payloadBytes("é")).toBe(4);
    const cache = new CompletedCache({
      maxBytes: 8,
      maxEntryBytes: 8,
      maxEntries: 2,
    });
    const value = (data: string) => ({
      descriptor: issue,
      data,
      fetchedAt: 0,
      generation: 0,
      revision: 1,
      payloadBytes: payloadBytes(data),
      accessedAt: 0,
    });
    expect(cache.set("one", value("a"))).toBe(true);
    expect(cache.set("two", value("b"))).toBe(true);
    cache.get("one", 1);
    cache.set("three", value("c"));
    expect(cache.get("two")).toBeUndefined();
    cache.pin("one");
    cache.pin("three");
    expect(cache.set("four", value("d"))).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.totalBytes).toBe(6);
    cache.unpin("one", 10);
    cache.sweep(300_010);
    expect(cache.get("one")).toBeUndefined();
    expect(cache.get("three")).toBeDefined();
  });

  it("enforces entry count, idle eviction, and oversized delivery without residency", async () => {
    const { runtime, requests } = harness({
      limits: { maxEntries: 1, maxEntryBytes: 10, maxBytes: 20, idleMs: 100 },
    });
    const big = runtime.read(issue);
    requests[0]!.pending.resolve("this is too large");
    await expect(big).resolves.toBe("this is too large");
    await flush();
    expect(runtime.stats.entries).toBe(0);
    const one = runtime.read(issue);
    requests[1]!.pending.resolve(1);
    await one;
    await flush();
    const two = runtime.read(otherIssue);
    requests[2]!.pending.resolve(2);
    await two;
    await flush();
    expect(runtime.stats.entries).toBe(1);
    expect(runtime.peek(issue)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(101);
    expect(runtime.stats.entries).toBe(0);
  });

  it("does not retain oversized values indirectly in projection snapshots", async () => {
    const { runtime, requests } = harness({ limits: { maxEntryBytes: 8 } });
    const listener = vi.fn();
    runtime.subscribe(
      "a",
      projection(),
      { enabled: true, visible: true },
      listener,
    );
    requests[0]!.pending.resolve("oversized value");
    await flush();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: "oversized value" }),
    );
    expect(
      runtime.cacheView.getQueryData(projection().queryKey),
    ).toBeUndefined();
    expect(runtime.stats.entries).toBe(0);
  });

  it("bounds raw plus projected payload and releases inactive superseded values", async () => {
    const { runtime, requests } = harness({
      limits: { maxEntryBytes: 20, maxBytes: 20 },
    });
    const first = runtime.readProjection(projection());
    requests[0]!.pending.resolve("old");
    await first;
    await flush();
    expect(runtime.cacheView.getQueryData(projection().queryKey)).toBe("old");
    const replacement = runtime.read(issue, { forceFresh: true });
    requests[1]!.pending.resolve("new");
    await replacement;
    await flush();
    expect(
      runtime.cacheView.getQueryData(projection().queryKey),
    ).toBeUndefined();
    await runtime.readProjection(projection());
    expect(runtime.cacheView.getQueryData(projection().queryKey)).toBe("new");
    const other = runtime.read(otherIssue);
    requests[2]!.pending.resolve("0123456789");
    await other;
    await flush();
    expect(runtime.stats.bytes).toBe(17);
    expect(
      runtime.cacheView.getQueryData(projection().queryKey),
    ).toBeUndefined();
  });

  it("ignores a late store load after generation invalidation and after session reset", async () => {
    const loaded = deferred<readonly SnapshotRecord[]>();
    const store: SnapshotStore = {
      ...new EmptySnapshotStore(),
      load: () => loaded.promise,
      put: async () => {},
      invalidateScope: async () => {},
      clearAccount: async () => {},
    };
    const { runtime } = harness({
      store,
      accountEpoch: 1,
      accountId: "alice",
      origin: "https://todou.example",
    });
    const restoring = runtime.restore(issue);
    const record: SnapshotRecord = {
      schemaVersion: 1,
      origin: "https://todou.example",
      apiMount: "/api",
      accountId: "alice",
      epoch: 1,
      descriptor: issue,
      payload: "old disk",
      fetchedAt: Date.now(),
      generation: runtime.getGeneration(issue),
      payloadBytes: 10,
    };
    await runtime.invalidate([{ type: "resource", resource: issue }], {
      refetchType: "none",
    });
    loaded.resolve([record]);
    await restoring;
    expect(runtime.peek(issue)).toBeUndefined();
    const late = deferred<readonly SnapshotRecord[]>();
    store.load = () => late.promise;
    const next = runtime.restore(issue);
    runtime.setEpoch(2, "bob");
    late.resolve([record]);
    await next;
    expect(runtime.peek(issue)).toBeUndefined();
  });

  it("a network winner supersedes old store load and invalidation revokes put guards", async () => {
    const loaded = deferred<readonly SnapshotRecord[]>();
    const saved = deferred<void>();
    let guard: StoreGuard | undefined;
    const invalidateScope = vi.fn(async () => {});
    const store: SnapshotStore = {
      load: () => loaded.promise,
      put: vi.fn((_record, check) => {
        guard = check;
        return saved.promise;
      }),
      invalidateScope,
      clearAccount: async () => {},
    };
    const { runtime, requests } = harness({
      store,
      accountEpoch: 1,
      accountId: "alice",
      origin: "https://todou.example",
    });
    const restoring = runtime.restore(issue);
    const fetched = runtime.read(issue);
    requests[0]!.pending.resolve("network");
    await fetched;
    await flush();
    loaded.resolve([
      {
        schemaVersion: 1,
        origin: "https://todou.example",
        apiMount: "/api",
        accountId: "alice",
        epoch: 1,
        descriptor: issue,
        payload: "older",
        fetchedAt: Date.now(),
        generation: 0,
        payloadBytes: 7,
      },
    ]);
    await restoring;
    expect(runtime.peek(issue)?.data).toBe("network");
    expect(guard?.()).toBe(true);
    await runtime.invalidate([{ type: "resource", resource: issue }], {
      refetchType: "none",
    });
    expect(guard?.()).toBe(false);
    saved.resolve();
    await flush();
    expect(invalidateScope).toHaveBeenCalled();
    expect(runtime.peek(issue)?.stale).toBe(true);
  });

  it("store failures never replace successful network results", async () => {
    const store: SnapshotStore = {
      load: async () => {
        throw new Error("disk");
      },
      put: async () => {
        throw new Error("disk");
      },
      invalidateScope: async () => {
        throw new Error("disk");
      },
      clearAccount: async () => {
        throw new Error("disk");
      },
    };
    const { runtime, requests } = harness({ store });
    await runtime.restore(issue);
    const result = runtime.read(issue);
    requests[0]!.pending.resolve("ok");
    await expect(result).resolves.toBe("ok");
    await flush();
    expect(runtime.peek(issue)?.data).toBe("ok");
  });

  it("resources and descriptors remain isolated across epochs and policies", () => {
    expect(resourceId(issue, 1)).not.toBe(resourceId(issue, 2));
    expect(resourceId(issue)).not.toBe(resourceId(networkResource(issue.path)));
  });
});

describe("protocol shape boundary", () => {
  const envelope = {
    protocolVersion: 1,
    runtimeGeneration: "worker-one",
    portId: "port-one",
    requestId: "1",
    accountEpoch: 1,
  };
  it("rejects unknown types, both read payloads, malformed descriptors and executable params", () => {
    expect(() =>
      validateClientMessage({ ...envelope, type: "EXECUTE", code: "anything" }),
    ).toThrow();
    expect(() =>
      validateClientMessage({
        ...envelope,
        type: "READ_FRESH",
        resource: issue,
        projection: projection(),
      }),
    ).toThrow();
    expect(() =>
      validateClientMessage({
        ...envelope,
        type: "READ_FRESH",
        resource: { ...issue, policyId: "anything" },
      }),
    ).toThrow();
    expect(() =>
      validateClientMessage({
        ...envelope,
        type: "SUBSCRIBE",
        subscriptionId: "x",
        enabled: true,
        visible: true,
        projection: { ...projection(), params: { execute: () => 1 } },
      }),
    ).toThrow();
    expect(() =>
      validateClientMessage({
        ...envelope,
        type: "READ_FRESH",
        projection: projection(),
      }),
    ).not.toThrow();
  });
});
