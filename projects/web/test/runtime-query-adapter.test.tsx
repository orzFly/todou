import {
  QueryClient,
  QueryObserver,
  queryOptions,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBridge, RuntimeMode } from "@/api/runtime/bridge.ts";
import type { ProjectionDescriptor } from "@/api/runtime/projections.ts";
import type { RuntimeSnapshot } from "@/api/runtime/protocol.ts";
import {
  beginRuntimeWrite,
  installRuntimeQueryAdapter,
  runtimeProjection,
  runtimeQueryOptions,
  settleRuntimeWrite,
  wrapRuntimeRefetch,
  writeRuntimeData,
} from "@/api/runtime/query-adapter.ts";
import { resource } from "@/api/runtime/resources.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(initialMode: RuntimeMode = "worker") {
  const snapshots = new Map<string, (snapshot: RuntimeSnapshot) => void>();
  const subscriptions = new Map<string, ProjectionDescriptor>();
  const resets = new Set<(reason: string) => void>();
  const modes = new Set<(mode: RuntimeMode) => void>();
  let mode = initialMode;
  const bridge = {
    get mode() {
      return mode;
    },
    ready: Promise.resolve(),
    bootstrap: vi.fn(),
    read: vi.fn(),
    readProjection: vi.fn(async () => ({ value: "network" })),
    control: vi.fn(async () => ({ generationByTarget: {} })),
    subscribe: vi.fn(
      (
        projection: ProjectionDescriptor,
        _options: unknown,
        listener: (snapshot: RuntimeSnapshot) => void,
      ) => {
        subscriptions.set(projection.queryHash, projection);
        snapshots.set(projection.queryHash, listener);
        return () => {
          snapshots.delete(projection.queryHash);
          subscriptions.delete(projection.queryHash);
        };
      },
    ),
    onMode: (listener: (mode: RuntimeMode) => void) => {
      modes.add(listener);
      return () => {
        modes.delete(listener);
      };
    },
    onSessionReset: (listener: (reason: string) => void) => {
      resets.add(listener);
      return () => {
        resets.delete(listener);
      };
    },
    onFrame: () => () => {},
    authTransition: async <T,>(action: () => Promise<T>) => action(),
    authRedirect: vi.fn(),
    captureAuthFence: () => undefined,
    assertAuthFence: () => {},
    dispose: () => {},
  } as unknown as RuntimeBridge;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const adapter = installRuntimeQueryAdapter(client, bridge);
  const options = runtimeQueryOptions(
    queryOptions({
      queryKey: ["issue", "demo", 1],
      queryFn: vi.fn(async () => ({ value: "fallback" })),
      staleTime: 5_000,
      retry: false,
    }),
    {
      kind: "direct",
      resources: [resource("issue", "/projects/demo/issues/1")],
    },
  );
  const projection = runtimeProjection(options)!;
  const emit = (patch: Partial<RuntimeSnapshot> = {}) =>
    snapshots.get(projection.queryHash)?.({
      projectionHash: projection.queryHash,
      status: "success",
      fetchStatus: "idle",
      data: { value: "snapshot" },
      fetchedAt: Date.now(),
      stale: false,
      revision: 1,
      generation: 0,
      ...patch,
    });
  const observe = (patch: Partial<typeof options> = {}) => {
    const observer = new QueryObserver(client, { ...options, ...patch });
    const release = observer.subscribe(() => {});
    return { observer, release };
  };
  return {
    bridge,
    client,
    adapter,
    options,
    projection,
    emit,
    observe,
    snapshots,
    subscriptions,
    reset: () => {
      for (const listener of resets) listener("test-reset");
    },
    mode: (value: RuntimeMode) => {
      mode = value;
      for (const listener of modes) listener(value);
    },
    dispose: () => {
      adapter.dispose();
      client.clear();
    },
  };
}
const owned: { dispose(): void }[] = [];
function setup(mode?: RuntimeMode) {
  const result = harness(mode);
  owned.push(result);
  return result;
}
afterEach(() => {
  for (const item of owned.splice(0)) item.dispose();
  vi.restoreAllMocks();
});

describe("shared QueryClient adapter", () => {
  it.each(["project", "members"] as const)(
    "requires this page's first %s permission read before exposing a shared role",
    async (policy) => {
      const h = setup();
      const options = runtimeQueryOptions(
        queryOptions({
          queryKey: [policy, "demo"],
          queryFn: async () => ({ role: "fallback" }),
          staleTime: 60_000,
        }),
        {
          kind: "direct",
          resources: [
            resource(
              policy,
              `/projects/demo${policy === "members" ? "/members" : ""}`,
            ),
          ],
        },
      );
      const projection = runtimeProjection(options)!;
      const response = deferred<{ role: string }>();
      vi.mocked(h.bridge.readProjection).mockReturnValue(response.promise);
      const first = new QueryObserver(h.client, options);
      const second = new QueryObserver(h.client, options);
      const releaseFirst = first.subscribe(() => {});
      const releaseSecond = second.subscribe(() => {});
      h.snapshots.get(projection.queryHash)?.({
        projectionHash: projection.queryHash,
        status: "success",
        fetchStatus: "idle",
        data: { role: "admin" },
        fetchedAt: Date.now(),
        revision: 1,
        generation: 0,
        stale: false,
      });
      expect(first.getCurrentResult().data).toBeUndefined();
      expect(second.getCurrentResult().data).toBeUndefined();
      const pending = h.client.fetchQuery(options);
      const rejected = expect(pending).rejects.toThrow("forbidden");
      await Promise.resolve();
      expect(h.bridge.readProjection).toHaveBeenCalledTimes(1);
      expect(h.bridge.readProjection).toHaveBeenCalledWith(
        projection,
        expect.objectContaining({ freshnessMs: 0 }),
      );
      response.reject(new Error("forbidden"));
      await rejected;
      expect(h.client.getQueryData(options.queryKey)).toBeUndefined();
      releaseFirst();
      releaseSecond();
    },
  );

  it("returns permission reads to their metadata policy after verification and rechecks after reset", async () => {
    const h = setup();
    const options = runtimeQueryOptions(
      queryOptions({
        queryKey: ["project", "demo"],
        queryFn: async () => ({ role: "fallback" }),
        staleTime: 60_000,
      }),
      { kind: "direct", resources: [resource("project", "/projects/demo")] },
    );
    await h.client.fetchQuery(options);
    expect(h.bridge.readProjection).toHaveBeenLastCalledWith(
      runtimeProjection(options),
      expect.objectContaining({ freshnessMs: 0 }),
    );
    await h.client.fetchQuery(options);
    expect(h.bridge.readProjection).toHaveBeenLastCalledWith(
      runtimeProjection(options),
      expect.objectContaining({ freshnessMs: 60_000 }),
    );
    h.reset();
    await h.adapter.resumeSession();
    await h.client.fetchQuery(options);
    expect(h.bridge.readProjection).toHaveBeenLastCalledWith(
      runtimeProjection(options),
      expect.objectContaining({ freshnessMs: 0 }),
    );
  });

  it("preserves native fallback options and queryFn", async () => {
    const h = setup("fallback");
    expect(h.client.defaultQueryOptions(h.options).staleTime).toBe(5_000);
    expect(await h.client.fetchQuery(h.options)).toEqual({ value: "fallback" });
    expect(h.bridge.readProjection).not.toHaveBeenCalled();
  });

  it("consults worker freshness on imperative reads even with a warm Infinity mirror", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "old" });
    expect(h.client.defaultQueryOptions(h.options).staleTime).toBe(Infinity);
    await expect(h.client.fetchQuery(h.options)).resolves.toEqual({
      value: "network",
    });
    expect(h.bridge.readProjection).toHaveBeenCalledTimes(1);
    expect(h.options.queryFn).not.toHaveBeenCalled();
  });

  it("keeps ensureQueryData stale return and optional revalidation, prefetch swallows errors", async () => {
    const h = setup();
    h.client.setQueryData(
      h.options.queryKey,
      { value: "old" },
      { updatedAt: 1 },
    );
    await expect(h.client.ensureQueryData(h.options)).resolves.toEqual({
      value: "old",
    });
    expect(h.bridge.readProjection).not.toHaveBeenCalled();
    await expect(
      h.client.ensureQueryData({ ...h.options, revalidateIfStale: true }),
    ).resolves.toEqual({ value: "old" });
    await h.client.fetchQuery(h.options);
    expect(h.bridge.readProjection).toHaveBeenCalled();
    vi.mocked(h.bridge.readProjection).mockRejectedValue(new Error("offline"));
    await expect(h.client.prefetchQuery(h.options)).resolves.toBeUndefined();
    expect(h.client.getQueryState(h.options.queryKey)?.error?.message).toBe(
      "offline",
    );
  });

  it("forwards explicit imperative freshness and minimum enabled observer freshness", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "cached" });
    vi.mocked(h.bridge.readProjection).mockImplementation(
      async (_projection, options) =>
        options?.freshnessMs === 0
          ? { value: "verified" }
          : { value: "cached" },
    );
    await expect(
      h.client.fetchQuery({ ...h.options, staleTime: 0 }),
    ).resolves.toEqual({ value: "verified" });
    expect(h.bridge.readProjection).toHaveBeenLastCalledWith(
      h.projection,
      expect.objectContaining({ freshnessMs: 0 }),
    );
    const slow = new QueryObserver(h.client, {
      ...h.options,
      staleTime: 4_000,
    });
    const fast = new QueryObserver(h.client, { ...h.options, staleTime: 500 });
    const disabled = new QueryObserver(h.client, {
      ...h.options,
      staleTime: 0,
      enabled: false,
    });
    const releaseSlow = slow.subscribe(() => {});
    const releaseFast = fast.subscribe(() => {});
    const releaseDisabled = disabled.subscribe(() => {});
    expect(h.bridge.subscribe).toHaveBeenLastCalledWith(
      h.projection,
      expect.objectContaining({ enabled: true, freshnessMs: 500 }),
      expect.any(Function),
    );
    releaseFast();
    expect(h.bridge.subscribe).toHaveBeenLastCalledWith(
      h.projection,
      expect.objectContaining({ enabled: true, freshnessMs: 4_000 }),
      expect.any(Function),
    );
    releaseDisabled();
    releaseSlow();
  });

  it("suppresses page scheduling and retains observer enabled/select semantics", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "seed" });
    const disabled = new QueryObserver(h.client, {
      ...h.options,
      enabled: false,
      staleTime: 0,
    });
    const firstRelease = disabled.subscribe(() => {});
    const selected = new QueryObserver(h.client, {
      ...h.options,
      select: (data) => data.value,
    });
    const secondRelease = selected.subscribe(() => {});
    expect(disabled.options.enabled).toBe(false);
    expect(selected.options.refetchOnWindowFocus).toBe(false);
    expect(selected.options.refetchOnReconnect).toBe(false);
    expect(selected.options.refetchInterval).toBe(false);
    expect(selected.options.retry).toBe(false);
    h.emit();
    expect(selected.getCurrentResult().data).toBe("snapshot");
    expect(disabled.getCurrentResult().data).toEqual({ value: "snapshot" });
    firstRelease();
    secondRelease();
    expect(h.snapshots.size).toBe(0);
  });

  it("awaits reads-settled invalidation and sends dirty-only with no selected reads", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "old" });
    const { release } = h.observe();
    const completion = deferred<unknown>();
    vi.mocked(h.bridge.control).mockImplementation(async (type, payload) =>
      type === "INVALIDATE" && payload.refetchType !== "none"
        ? completion.promise
        : { generationByTarget: {} },
    );
    let done = false;
    const invalidation = h.client
      .invalidateQueries({ queryKey: ["issue", "demo"] })
      .then(() => {
        done = true;
      });
    await Promise.resolve();
    expect(done).toBe(false);
    h.emit({ revision: 2, data: { value: "updated" } });
    completion.resolve({ generationByTarget: {} });
    await invalidation;
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "updated",
    });
    await h.client.invalidateQueries({
      queryKey: h.options.queryKey,
      refetchType: "none",
    });
    expect(h.bridge.control).toHaveBeenCalledWith(
      "INVALIDATE",
      expect.objectContaining({
        refetchType: "none",
        completion: "dirty-applied",
        selection: [],
      }),
    );
    await h.client.invalidateQueries({ refetchType: "none" });
    expect(h.bridge.control).toHaveBeenCalledWith(
      "INVALIDATE",
      expect.objectContaining({ targets: [{ type: "user" }] }),
    );
    release();
  });

  it("propagates invalidation throwOnError and waits for hook REFRESH ACK before observer fetch", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "seed" });
    const { release } = h.observe();
    const ack = deferred<unknown>();
    vi.mocked(h.bridge.control).mockImplementation(async (type) =>
      type === "REFRESH" ? ack.promise : {},
    );
    const refetch = vi.fn(async () => "result");
    const result = wrapRuntimeRefetch(h.client, h.options.queryKey, {
      refetch,
    });
    const pending = result.refetch();
    expect(refetch).not.toHaveBeenCalled();
    ack.resolve({ generationByTarget: {} });
    await expect(pending).resolves.toBe("result");
    expect(refetch).toHaveBeenCalledTimes(1);
    vi.mocked(h.bridge.control).mockRejectedValueOnce(new Error("denied"));
    await expect(
      h.client.invalidateQueries({}, { throwOnError: true }),
    ).rejects.toThrow("denied");
    release();
  });

  it("releases a failed reset barrier and accepts later snapshots without another refresh", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "warm" });
    const { release } = h.observe();
    const completion = deferred<unknown>();
    vi.mocked(h.bridge.control).mockImplementation(async (type) =>
      type === "REFRESH" ? completion.promise : { generationByTarget: {} },
    );
    const reset = h.client.resetQueries(
      { queryKey: h.options.queryKey },
      { throwOnError: true },
    );
    const rejected = expect(reset).rejects.toThrow("offline");
    h.emit({
      status: "error",
      revision: 2,
      error: { kind: "unknown", name: "Error", message: "offline" },
    });
    completion.reject(new Error("offline"));
    await rejected;
    expect(h.client.getQueryState(h.options.queryKey)?.error?.message).toBe(
      "offline",
    );
    h.emit({ revision: 3, data: { value: "recovered" } });
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "recovered",
    });
    expect(h.client.getQueryState(h.options.queryKey)?.error).toBeNull();
    release();
  });

  it("holds optimistic and rollback data until owner settlement, then replays fresh snapshot", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "server" });
    const { release } = h.observe();
    const owner = beginRuntimeWrite(h.client, { queryKey: h.options.queryKey });
    await h.client.cancelQueries({ queryKey: h.options.queryKey });
    writeRuntimeData(
      h.client,
      h.options.queryKey,
      { value: "optimistic" },
      owner,
    );
    h.emit({ revision: 2, data: { value: "fresh" } });
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "optimistic",
    });
    writeRuntimeData(
      h.client,
      h.options.queryKey,
      { value: "rollback" },
      owner,
    );
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "rollback",
    });
    await settleRuntimeWrite(h.client, owner);
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "fresh",
    });
    release();
  });

  it("keeps warm error data, clears errors on success, and does not resurrect permission-dropped data", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "old" });
    const { release } = h.observe();
    h.emit({
      status: "error",
      revision: 2,
      error: { kind: "unknown", name: "Error", message: "offline" },
    });
    expect(h.client.getQueryState(h.options.queryKey)?.status).toBe("error");
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({ value: "old" });
    h.emit({ revision: 3 });
    expect(h.client.getQueryState(h.options.queryKey)?.error).toBeNull();
    h.emit({
      status: "error",
      revision: 4,
      dropData: true,
      error: { kind: "unknown", name: "Error", message: "forbidden" },
    });
    await h.client.cancelQueries({ queryKey: h.options.queryKey });
    expect(h.client.getQueryData(h.options.queryKey)).toBeUndefined();
    release();
  });

  it("revokes late snapshots and local writers on session reset and clear", async () => {
    const h = setup();
    h.client.setQueryData(h.options.queryKey, { value: "old identity" });
    const { release } = h.observe();
    const oldListener = h.snapshots.get(h.projection.queryHash)!;
    const owner = beginRuntimeWrite(h.client, { queryKey: h.options.queryKey });
    h.reset();
    oldListener({
      projectionHash: h.projection.queryHash,
      status: "success",
      fetchStatus: "idle",
      data: { value: "late" },
      fetchedAt: Date.now(),
      revision: 100,
      generation: 0,
      stale: false,
    });
    writeRuntimeData(
      h.client,
      h.options.queryKey,
      { value: "late optimistic" },
      owner,
    );
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "old identity",
    });
    await expect(h.client.fetchQuery(h.options)).rejects.toMatchObject({
      name: "AbortError",
    });
    await h.adapter.resumeSession();
    h.emit({ data: { value: "verified" } });
    expect(h.client.getQueryData(h.options.queryKey)).toEqual({
      value: "verified",
    });
    expect(h.client.clear()).toBeUndefined();
    oldListener({
      projectionHash: h.projection.queryHash,
      status: "success",
      fetchStatus: "idle",
      data: { value: "late" },
      fetchedAt: Date.now(),
      revision: 101,
      generation: 0,
      stale: false,
    });
    expect(h.client.getQueryData(h.options.queryKey)).toBeUndefined();
    release();
  });
});
