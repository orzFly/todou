import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeBridge,
  type RuntimeBridge,
} from "../src/api/runtime/bridge.ts";
import { deferred } from "../src/api/runtime/deferred.ts";
import {
  defineProjection,
  projectionId,
  timelineResource,
} from "../src/api/runtime/projections.ts";
import { installRuntimeQueryAdapter } from "../src/api/runtime/query-adapter.ts";
import { ResourceRuntime } from "../src/api/runtime/runtime.ts";
import {
  PORT_LEASE_MS,
  RuntimeSessionHost,
} from "../src/api/runtime/session.ts";
import {
  authEnvironment,
  hello,
  identity,
  issueProjection,
  issueResource,
  ports,
  settle,
  workerFactory,
} from "./runtime-harness.ts";

const disposals: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
});

function setup() {
  const network = vi.fn(async () => ({ title: "fresh" }));
  const runtime = new ResourceRuntime({ network });
  const onlineIdentity = vi.fn(async () => identity());
  const host = new RuntimeSessionHost({
    runtime,
    onlineIdentity,
    apiMount: "/api",
    pageOrigin: "https://todou.example",
    buildId: "test",
  });
  const workers = workerFactory(host);
  const auth = authEnvironment();
  const events = new EventTarget();
  const pageDocument = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const bridge = createRuntimeBridge({
    apiMount: "/api",
    buildId: "test",
    pageOrigin: "https://todou.example",
    authControl: auth.control(),
    workerFactory: workers.factory,
    events,
    document: pageDocument,
    online: () => true,
  });
  disposals.push(
    () => bridge.dispose(),
    () => host.dispose(),
  );
  return {
    network,
    runtime,
    onlineIdentity,
    host,
    workers,
    auth,
    events,
    pageDocument,
    bridge,
  };
}

describe("worker page lifecycle", () => {
  it("reconciles ordinary same-port visibility restores without orphan observers", async () => {
    const { bridge, runtime, pageDocument, network, workers } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    let unsubscribe = bridge.subscribe(
      issueProjection,
      { enabled: true },
      () => {},
    );
    const stopReset = bridge.onSessionReset(() => unsubscribe());
    disposals.push(stopReset);
    await settle();
    for (let cycle = 0; cycle < 3; cycle++) {
      pageDocument.visibilityState = "hidden";
      pageDocument.dispatchEvent(new Event("visibilitychange"));
      await settle();
      pageDocument.visibilityState = "visible";
      pageDocument.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(runtime.stats.subscriptions).toBe(0);
      unsubscribe = bridge.subscribe(
        issueProjection,
        { enabled: true },
        () => {},
      );
      await settle();
      expect(runtime.stats.subscriptions).toBe(1);
    }
    expect(workers.workers).toHaveLength(1);
    unsubscribe();
    await settle();
    network.mockClear();
    await bridge.control("INVALIDATE", {
      targets: [{ type: "user" }],
      refetchType: "active",
      completion: "reads-settled",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("recovers a cold page's absent marker against an already-settled worker", async () => {
    const { bridge, host, auth, workers } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    await bridge.authTransition(async () => {});
    const oldEpoch = host.identity.epoch;
    auth.storage.removeItem("todou:auth-control:v1:/api");
    const onlineRecovery = vi.fn(async () => identity());
    const newcomer = createRuntimeBridge({
      apiMount: "/api",
      buildId: "test",
      pageOrigin: "https://todou.example",
      authControl: auth.control(),
      workerFactory: workers.factory,
      bootstrapFallback: onlineRecovery,
    });
    disposals.push(() => newcomer.dispose());
    await newcomer.ready;
    expect(await newcomer.bootstrap()).toEqual(identity());
    expect(onlineRecovery).toHaveBeenCalledTimes(1);
    expect(host.identity.epoch).toBeGreaterThan(oldEpoch);
    expect(await newcomer.read(issueResource)).toEqual({ title: "fresh" });
  });

  it("forwards stricter freshness for imperative reads and subscriptions", async () => {
    const { bridge, runtime } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    const read = vi.spyOn(runtime, "read");
    await bridge.read(issueResource, { freshnessMs: 0 });
    expect(read).toHaveBeenCalledWith(
      issueResource,
      expect.objectContaining({ freshnessMs: 0 }),
    );
    const subscribe = vi.spyOn(runtime, "subscribe");
    bridge.subscribe(
      issueProjection,
      { enabled: true, freshnessMs: 1000 },
      () => {},
    );
    await settle();
    expect(subscribe).toHaveBeenCalledWith(
      expect.any(String),
      issueProjection,
      expect.objectContaining({ freshnessMs: 1000 }),
      expect.any(Function),
    );
  });

  it("does not resurrect a subscription removed while its identity is revoked", async () => {
    const { bridge, runtime, host, network } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    const unsubscribe = bridge.subscribe(
      issueProjection,
      { enabled: true },
      () => {},
    );
    await settle();
    expect(runtime.stats.subscriptions).toBe(1);
    host.identity.revoke("clear");
    await settle();
    unsubscribe();
    await bridge.bootstrap();
    await settle();
    expect(runtime.stats.subscriptions).toBe(0);
    network.mockClear();
    await bridge.control("INVALIDATE", {
      targets: [{ type: "user" }],
      refetchType: "active",
      completion: "reads-settled",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("pauses and resumes only the full descriptor's timeline window", async () => {
    const runtime = new ResourceRuntime({
      network: async () => ({
        items: [],
        next_cursor: "next",
        prev_cursor: null,
        has_more: false,
      }),
    });
    const host = new RuntimeSessionHost({
      runtime,
      onlineIdentity: async () => identity(),
      apiMount: "/api",
      pageOrigin: "https://todou.example",
      buildId: "test",
    });
    const workers = workerFactory(host);
    const auth = authEnvironment();
    const bridge = createRuntimeBridge({
      apiMount: "/api",
      buildId: "test",
      pageOrigin: "https://todou.example",
      authControl: auth.control(),
      workerFactory: workers.factory,
    });
    disposals.push(
      () => bridge.dispose(),
      () => host.dispose(),
    );
    await bridge.ready;
    await bridge.bootstrap();
    const shallow = defineProjection({
      kind: "timeline-tail",
      version: 1,
      queryKey: ["timeline", "example", 1],
      queryHash: "timeline-key",
      resources: [timelineResource("example", 1, { dir: "init" })],
      windowDescriptor: { pageParams: [{ dir: "init" }], depth: 1 },
    });
    const deep = defineProjection({
      ...shallow,
      windowDescriptor: {
        pageParams: [{ dir: "init" }, { dir: "after", cursor: "next" }],
        depth: 2,
      },
    });
    const shallowListener = vi.fn();
    const deepListener = vi.fn();
    bridge.subscribe(shallow, { enabled: true }, shallowListener);
    bridge.subscribe(deep, { enabled: true }, deepListener);
    await settle();
    await bridge.control("CANCEL", {
      projectionIds: [projectionId(shallow)],
      suspendMirror: true,
    });
    shallowListener.mockClear();
    deepListener.mockClear();
    await bridge.control("INVALIDATE", {
      targets: [{ type: "key-prefix", queryKey: ["timeline"] }],
      completion: "reads-settled",
      refetchType: "active",
    });
    expect(shallowListener).not.toHaveBeenCalled();
    expect(
      deepListener.mock.calls.some(
        ([snapshot]) => snapshot.data?.pages.length === 2,
      ),
    ).toBe(true);
    await bridge.control("RESUME", { projectionIds: [projectionId(shallow)] });
    await settle();
    expect(
      shallowListener.mock.calls.some(
        ([snapshot]) => snapshot.data?.pages.length === 1,
      ),
    ).toBe(true);
  });

  it("shares completed values and ongoing snapshots, including a valid hidden subscriber", async () => {
    const { bridge, host, workers, auth, network } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    const hiddenDocument = Object.assign(new EventTarget(), {
      visibilityState: "hidden" as DocumentVisibilityState,
    });
    const second = createRuntimeBridge({
      apiMount: "/api",
      buildId: "test",
      pageOrigin: "https://todou.example",
      workerFactory: workers.factory,
      authControl: auth.control(),
      events: new EventTarget(),
      document: hiddenDocument,
    });
    disposals.push(() => second.dispose());
    await second.ready;
    await second.bootstrap();
    const visible = vi.fn();
    const hidden = vi.fn();
    bridge.subscribe(issueProjection, { enabled: true }, visible);
    second.subscribe(issueProjection, { enabled: true }, hidden);
    await settle();
    expect(network).toHaveBeenCalledTimes(1);
    expect(
      visible.mock.calls.some(([snapshot]) => snapshot.data?.title === "fresh"),
    ).toBe(true);
    expect(
      hidden.mock.calls.some(([snapshot]) => snapshot.data?.title === "fresh"),
    ).toBe(true);
    expect(await second.read(issueResource)).toEqual({ title: "fresh" });
    expect(network).toHaveBeenCalledTimes(1);
    expect(host.portCount).toBe(2);
  });

  it("expires hidden leases while visible probes retain their ports", async () => {
    const { bridge, host, pageDocument, onlineIdentity, workers } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    await vi.advanceTimersByTimeAsync(PORT_LEASE_MS + 15_000);
    expect(host.portCount).toBe(1);
    pageDocument.visibilityState = "hidden";
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    await settle();
    await vi.advanceTimersByTimeAsync(PORT_LEASE_MS + 15_000);
    expect(host.portCount).toBe(0);
    const calls = onlineIdentity.mock.calls.length;
    pageDocument.visibilityState = "visible";
    pageDocument.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(workers.workers).toHaveLength(2);
    expect(host.portCount).toBe(1);
    expect(onlineIdentity.mock.calls.length).toBeGreaterThan(calls);
    expect(await bridge.read(issueResource)).toEqual({ title: "fresh" });
  });

  it("detaches at freeze and restores only after a new online identity gate", async () => {
    const { bridge, host, events, onlineIdentity, workers } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    const listener = vi.fn();
    bridge.subscribe(issueProjection, { enabled: true }, listener);
    await settle();
    events.dispatchEvent(new Event("freeze"));
    await settle();
    expect(host.portCount).toBe(0);
    const calls = onlineIdentity.mock.calls.length;
    events.dispatchEvent(new Event("resume"));
    await settle();
    expect(workers.workers).toHaveLength(2);
    expect(onlineIdentity.mock.calls.length).toBeGreaterThan(calls);
    expect(host.portCount).toBe(1);
    expect(await bridge.read(issueResource)).toEqual({ title: "fresh" });
  });

  it("rebuilds once after worker loss then remains in fallback", async () => {
    const { bridge, workers } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    workers.workers[0]!.onerror?.(new Event("error"));
    await settle();
    expect(workers.workers).toHaveLength(2);
    expect(bridge.mode).toBe("worker");
    workers.workers[1]!.onerror?.(new Event("error"));
    await settle();
    expect(bridge.mode).toBe("fallback");
    expect(workers.workers).toHaveLength(2);
  });

  it("uses the 2s handshake deadline for each of at most two attempts", async () => {
    const auth = authEnvironment();
    const factory = vi.fn(() => ({ port: ports().page, onerror: null }));
    const bootstrapFallback = vi.fn(async () => identity());
    const bridge = createRuntimeBridge({
      apiMount: "/api",
      buildId: "test",
      pageOrigin: "https://todou.example",
      authControl: auth.control(),
      workerFactory: factory,
      bootstrapFallback,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const adapter = installRuntimeQueryAdapter(queryClient, bridge);
    const reset = vi.fn();
    const unsubscribeReset = bridge.onSessionReset(reset);
    disposals.push(() => {
      unsubscribeReset();
      adapter.dispose();
      queryClient.clear();
      bridge.dispose();
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(bridge.mode).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    await bridge.ready;
    expect(bridge.mode).toBe("fallback");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalled();
    const observer = new QueryObserver(queryClient, {
      queryKey: ["me"],
      queryFn: () => bridge.bootstrap(),
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    disposals.push(unsubscribe);
    await settle();
    expect(bootstrapFallback).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().status).toBe("success");
    expect(observer.getCurrentResult().data).toEqual(identity());
  });

  it("keeps ACK separate from read settlement and cancels only this consumer", async () => {
    const { bridge, runtime } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    const wait = deferred<void>();
    vi.spyOn(runtime, "invalidate").mockImplementation((_targets, options) => {
      options?.onApplied?.({ issue: 2 });
      return wait.promise;
    });
    let settled = false;
    const control = bridge
      .control("INVALIDATE", {
        targets: [{ type: "user" }],
        completion: "reads-settled",
      })
      .then(() => {
        settled = true;
      });
    await settle();
    expect(settled).toBe(false);
    wait.resolve();
    await control;
    expect(settled).toBe(true);
    const flight = deferred<unknown>();
    vi.spyOn(runtime, "read").mockReturnValue(flight.promise);
    const controller = new AbortController();
    const read = bridge.read(issueResource, { signal: controller.signal });
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    controller.abort();
    await rejected;
    flight.resolve({ obsolete: true });
    await settle();
  });

  it("rejects a private result if storage changes before its channel notification", async () => {
    const { bridge, runtime, auth } = setup();
    await bridge.ready;
    await bridge.bootstrap();
    const flight = deferred<unknown>();
    vi.spyOn(runtime, "read").mockReturnValue(flight.promise);
    const pending = bridge.read(issueResource);
    const rejected = expect(pending).rejects.toMatchObject({
      kind: "session-reset",
    });
    await settle();
    auth.storage.setItem(
      "todou:auth-control:v1:/api",
      JSON.stringify({ transitionId: "remote-auth", phase: "begin" }),
    );
    flight.resolve({ private: "old account" });
    await rejected;
  });

  it("never starts a SharedWorker without both locks and durable auth marker storage", async () => {
    const auth = authEnvironment();
    const factory = vi.fn(() => ({ port: ports().page, onerror: null }));
    const bridge: RuntimeBridge = createRuntimeBridge({
      authControl: auth.control(false),
      workerFactory: factory,
      bootstrapFallback: async () => identity(),
    });
    disposals.push(() => bridge.dispose());
    await bridge.ready;
    expect(bridge.mode).toBe("fallback");
    expect(factory).not.toHaveBeenCalled();
    expect(await bridge.bootstrap()).toEqual(identity());
  });

  it("cleans up the final raw port's demand after DETACH", async () => {
    const runtime = new ResourceRuntime({ network: async () => ({}) });
    const demand = vi.fn();
    const host = new RuntimeSessionHost({
      runtime,
      onlineIdentity: async () => identity(),
      apiMount: "/api",
      pageOrigin: "https://todou.example",
      onDemand: demand,
    });
    disposals.push(() => host.dispose());
    const page = await hello(host);
    page.send("AUTH_BOOTSTRAP");
    await settle();
    page.send("DETACH");
    await settle();
    expect(host.portCount).toBe(0);
    expect(demand).toHaveBeenLastCalledWith({
      connected: false,
      visible: false,
      epoch: 0,
    });
  });
});
