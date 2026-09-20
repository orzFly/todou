import {
  type FetchQueryOptions,
  hashKey,
  type Query,
  type QueryClient,
  type QueryFilters,
  type QueryKey,
  type QueryObserver,
  type QueryObserverOptions,
  type RefetchOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type ClientErrorEnvelope,
  deserializeClientError,
} from "@todou/shared";
import type { RuntimeBridge } from "./bridge.ts";
import {
  defineProjection,
  type ProjectionDescriptor,
  projectionId,
  type TimelinePageParam,
} from "./projections.ts";
import {
  policyFor,
  type ResourceDescriptor,
  type ResourcePolicyId,
  type ResourceQuery,
  resource,
} from "./resources.ts";

type DescriptorInput = Omit<
  ProjectionDescriptor,
  "queryKey" | "queryHash" | "version" | "resources"
> & { version?: 1; resources: Array<ResourceDescriptor | undefined> };
type OptionsWithKey = { queryKey: QueryKey; meta?: Record<string, unknown> };
interface RuntimeMeta {
  projection: ProjectionDescriptor;
  mapError?: (error: Error) => Error;
}
type Snapshot = Parameters<Parameters<RuntimeBridge["subscribe"]>[2]>[0];
type ObserverOptions = QueryObserverOptions;
type Controls = { throwOnError?: boolean; cancelRefetch?: boolean };
type LocalWriteKind = "optimistic" | "network-seed" | "alias";

/** Disabled observers retain their native placeholder keys until parameters exist. */
export function pageResource(
  policyId: ResourcePolicyId,
  path: string,
  query?: ResourceQuery,
  apiMount?: string,
): ResourceDescriptor | undefined {
  if (
    /^\/projects\/(?:\/|$)/.test(path) ||
    /\/issues\/(?:0|NaN|undefined|null)(?:\/|$)/.test(path) ||
    (typeof query?.issue_number === "number" && query.issue_number <= 0) ||
    (typeof query?.version === "number" && query.version <= 0)
  )
    return undefined;
  return resource(policyId, path, query, apiMount);
}

/** Registration changes neither the original query key nor its inferred result type. */
export function runtimeQueryOptions<T extends OptionsWithKey>(
  options: T,
  descriptor: DescriptorInput,
  mapError?: (error: Error) => Error,
): T {
  const resources = descriptor.resources.filter(
    (item): item is ResourceDescriptor => item !== undefined,
  );
  if (resources.length !== descriptor.resources.length) return options;
  const projection = defineProjection({
    ...descriptor,
    resources,
    version: 1,
    queryKey: options.queryKey,
    queryHash: hashKey(options.queryKey),
    meta: { ...descriptor.meta, ...options.meta },
  });
  return {
    ...options,
    meta: {
      ...options.meta,
      runtime: { projection, mapError } satisfies RuntimeMeta,
    },
  };
}

export function runtimeProjection(options: {
  meta?: Record<string, unknown>;
}): ProjectionDescriptor | undefined {
  return runtimeMeta(options)?.projection;
}
function runtimeMeta(options: {
  meta?: Record<string, unknown>;
}): RuntimeMeta | undefined {
  return options.meta?.runtime as RuntimeMeta | undefined;
}
function isWindow(projection: ProjectionDescriptor) {
  return (
    projection.kind === "timeline-tail" || projection.kind === "timeline-head"
  );
}
function operationId() {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `query-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface Entry {
  query: Query;
  projection: ProjectionDescriptor;
  observers: Set<QueryObserver>;
  unsubscribe?: () => void;
  subscriptionKey?: string;
  subscriptionVersion: number;
  revision: number;
  generation: number;
  requiredGeneration: number;
  suspended: boolean;
  owners: Set<string>;
  pendingSnapshot?: { snapshot: Snapshot; version: number };
}
export interface RuntimeQueryAdapter {
  bridge: RuntimeBridge;
  dispose(): void;
  resumeSession(): Promise<void>;
  refresh(key: QueryKey, options?: Controls): Promise<void>;
  begin(
    filters: QueryFilters,
    kind: LocalWriteKind,
    ownerToken?: string,
  ): string;
  write<T>(
    key: QueryKey,
    data: T | undefined,
    ownerToken: string,
  ): T | undefined;
  settle(ownerToken: string): Promise<void>;
  seed<T>(key: QueryKey, data: T, options: SeedOptions): Promise<boolean>;
  /** Apply a worker frame to page-owned queries without echoing it to the worker. */
  pageInvalidation(action: () => void): void;
}
interface SeedOptions {
  projection?: ProjectionDescriptor;
  isCurrent?: () => boolean;
  ownerToken?: string;
}
const adapters = new WeakMap<QueryClient, RuntimeQueryAdapter>();

export function getRuntimeQueryAdapter(client: QueryClient) {
  return adapters.get(client);
}

/** Installs on this real QueryClient only. Native methods remain the mirror's private path. */
export function installRuntimeQueryAdapter(
  client: QueryClient,
  bridge: RuntimeBridge,
): RuntimeQueryAdapter {
  const existing = adapters.get(client);
  if (existing) return existing;
  const native = {
    defaultQueryOptions: client.defaultQueryOptions.bind(client),
    fetchQuery: client.fetchQuery.bind(client),
    prefetchQuery: client.prefetchQuery.bind(client),
    ensureQueryData: client.ensureQueryData.bind(client),
    invalidateQueries: client.invalidateQueries.bind(client),
    refetchQueries: client.refetchQueries.bind(client),
    resetQueries: client.resetQueries.bind(client),
    cancelQueries: client.cancelQueries.bind(client),
    clear: client.clear.bind(client),
    setQueryData: client.setQueryData.bind(client),
  };
  const entries = new Map<string, Entry>();
  const verifiedPermissions = new Set<string>();
  let permissionEpoch = 0;
  const originals = new WeakMap<object, ObserverOptions>();
  const writes = new Map<
    string,
    { kind: LocalWriteKind; entries: Set<Entry>; order: number }
  >();
  const latestOwner = new Map<string, { ownerToken: string; order: number }>();
  let nextWriteOrder = 0;
  const allObservers = new Set<QueryObserver>();
  let mirroring = false;
  let pageOnly = false;
  let disposed = false;
  let adjusting = false;
  let sessionPaused = false;

  function needsPermissionCheck(projection: ProjectionDescriptor): boolean {
    return (
      projection.resources.some(
        (item) => item.policyId === "project" || item.policyId === "members",
      ) && !verifiedPermissions.has(projection.queryHash)
    );
  }

  async function readProjection<T>(
    projection: ProjectionDescriptor,
    options: Parameters<RuntimeBridge["readProjection"]>[1],
  ): Promise<T> {
    const needsCheck = needsPermissionCheck(projection);
    const epoch = permissionEpoch;
    const data = await bridge.readProjection<T>(projection, {
      ...options,
      ...(needsCheck ? { freshnessMs: 0 } : {}),
    });
    if (epoch !== permissionEpoch || options?.signal?.aborted) {
      throw new DOMException(
        "Session permission check was cancelled",
        "AbortError",
      );
    }
    if (needsCheck) {
      verifiedPermissions.add(projection.queryHash);
      const entry = entries.get(projection.queryHash);
      if (entry) syncSubscription(entry);
    }
    return data;
  }

  function entryFor(query: Query): Entry | undefined {
    const projection = runtimeProjection(query.options);
    if (!projection) return undefined;
    let entry = entries.get(query.queryHash);
    if (!entry) {
      entry = {
        query,
        projection,
        observers: new Set(),
        subscriptionVersion: 0,
        revision: -1,
        generation: 0,
        requiredGeneration: 0,
        suspended: false,
        owners: new Set(),
      };
      entries.set(query.queryHash, entry);
    }
    return entry;
  }
  function currentProjection(entry: Entry): ProjectionDescriptor {
    if (!isWindow(entry.projection)) return entry.projection;
    const data = entry.query.state.data as
      | { pageParams?: TimelinePageParam[] }
      | undefined;
    if (data?.pageParams?.length) {
      return {
        ...entry.projection,
        windowDescriptor: {
          ...entry.projection.windowDescriptor,
          pageParams: data.pageParams,
          initialPageParam: entry.projection.windowDescriptor
            ?.initialPageParam ?? {
            dir:
              entry.projection.kind === "timeline-tail" ? "init" : "init-head",
          },
          depth: data.pageParams.length,
        },
      };
    }
    return entry.projection;
  }
  function selected(filters: QueryFilters = {}) {
    return client
      .getQueryCache()
      .findAll(filters)
      .flatMap((query) => {
        const entry = entryFor(query);
        return entry ? [entry] : [];
      });
  }
  function unmanaged(filters: QueryFilters = {}): QueryFilters {
    const predicate = filters.predicate;
    return {
      ...filters,
      predicate: (query) =>
        !runtimeProjection(query.options) && (!predicate || predicate(query)),
    };
  }
  function snapshotError(entry: Entry, value: unknown): Error {
    const error =
      value instanceof Error
        ? value
        : deserializeClientError(value as ClientErrorEnvelope);
    return runtimeMeta(entry.query.options)?.mapError?.(error) ?? error;
  }
  function mirror(entry: Entry, snapshot: Snapshot, version: number) {
    if (
      disposed ||
      sessionPaused ||
      bridge.mode !== "worker" ||
      version !== entry.subscriptionVersion ||
      snapshot.revision <= entry.revision ||
      snapshot.generation < entry.requiredGeneration
    )
      return;
    if (needsPermissionCheck(entry.projection)) {
      // A completed role snapshot from another page cannot authorize this page.
      // Discard its revision; only this page's online read opens the mirror.
      entry.revision = snapshot.revision;
      return;
    }
    if (entry.suspended || entry.owners.size > 0) {
      if (
        !entry.pendingSnapshot ||
        snapshot.revision > entry.pendingSnapshot.snapshot.revision
      )
        entry.pendingSnapshot = { snapshot, version };
      return;
    }
    entry.revision = snapshot.revision;
    entry.generation = snapshot.generation;
    const query = entry.query;
    mirroring = true;
    try {
      // setData updates Query's cancellation rollback snapshot as well. State-only
      // writes would allow a later cancelled fetch to resurrect pre-mirror data.
      if (snapshot.status === "success") {
        query.setData(snapshot.data, {
          updatedAt: snapshot.fetchedAt,
          manual: true,
        });
      } else if (snapshot.dropData) {
        query.setData(undefined, { updatedAt: 0, manual: true });
      }
      query.setState({
        ...(snapshot.dropData ? { data: undefined, dataUpdatedAt: 0 } : {}),
        status:
          snapshot.status === "pending" && query.state.data !== undefined
            ? query.state.status
            : snapshot.status,
        fetchStatus: snapshot.fetchStatus,
        error:
          snapshot.status === "error"
            ? snapshotError(entry, snapshot.error)
            : null,
        errorUpdatedAt:
          snapshot.status === "error" ? Date.now() : query.state.errorUpdatedAt,
        fetchFailureCount:
          snapshot.status === "error" ? query.state.fetchFailureCount + 1 : 0,
        fetchFailureReason:
          snapshot.status === "error"
            ? snapshotError(entry, snapshot.error)
            : null,
        isInvalidated: snapshot.stale,
      });
    } finally {
      mirroring = false;
    }
  }
  function syncSubscription(entry: Entry) {
    if (
      bridge.mode !== "worker" ||
      disposed ||
      sessionPaused ||
      entry.observers.size === 0
    ) {
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      entry.subscriptionKey = undefined;
      entry.subscriptionVersion++;
      return;
    }
    if (
      [...entry.owners].some(
        (owner) => writes.get(owner)?.kind === "network-seed",
      )
    )
      return;
    const projection = currentProjection(entry);
    const activeObservers = [...entry.observers].filter((observer) => {
      const enabled = originalOptions(observer.options).enabled;
      return (
        (typeof enabled === "function" ? enabled(entry.query) : enabled) !==
        false
      );
    });
    const enabled = activeObservers.length > 0;
    const freshnessMs = Math.min(
      ...projection.resources.map((item) => policyFor(item).freshnessMs),
      ...activeObservers.map((observer) => {
        const staleTime = originalOptions(observer.options).staleTime;
        const value =
          typeof staleTime === "function" ? staleTime(entry.query) : staleTime;
        return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
      }),
    );
    const key = `${projectionId(projection)}:${enabled}:${freshnessMs}`;
    if (key === entry.subscriptionKey) return;
    entry.unsubscribe?.();
    entry.projection = projection;
    entry.subscriptionKey = key;
    entry.revision = -1;
    const version = ++entry.subscriptionVersion;
    entry.unsubscribe = bridge.subscribe(
      projection,
      {
        enabled,
        freshnessMs: Number.isFinite(freshnessMs)
          ? Math.max(0, freshnessMs)
          : undefined,
      },
      (snapshot) => mirror(entry, snapshot, version),
    );
  }
  function originalOptions(options: ObserverOptions): ObserverOptions {
    return originals.get(options) ?? options;
  }
  function prepareOptions(options: ObserverOptions): ObserverOptions {
    const original = originalOptions(options);
    const meta = runtimeMeta(original);
    const privatePaused =
      sessionPaused &&
      original.queryKey[0] !== "auth-mode" &&
      original.queryKey[0] !== "server-version";
    if ((!meta || bridge.mode !== "worker") && !privatePaused) return original;
    const adjusted: ObserverOptions = {
      ...original,
      ...(privatePaused
        ? {
            queryFn: async (context) => {
              if (!sessionPaused && typeof original.queryFn === "function")
                return original.queryFn(context);
              throw new DOMException(
                "Session verification is pending",
                "AbortError",
              );
            },
          }
        : {}),
      ...(meta && bridge.mode === "worker" && !privatePaused
        ? {
            staleTime: Number.POSITIVE_INFINITY,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            refetchOnMount: false,
            refetchInterval: false,
            retry: false,
            ...(isWindow(meta.projection)
              ? {}
              : {
                  queryFn: async ({ signal }) => {
                    try {
                      return await readProjection(meta.projection, {
                        signal,
                        freshnessMs:
                          typeof original.staleTime === "number" &&
                          Number.isFinite(original.staleTime)
                            ? Math.max(0, original.staleTime)
                            : undefined,
                      });
                    } catch (error) {
                      throw meta.mapError?.(error as Error) ?? error;
                    }
                  },
                }),
          }
        : {}),
    };
    originals.set(adjusted, original);
    return adjusted;
  }
  client.defaultQueryOptions = ((options: ObserverOptions) => {
    const defaults = native.defaultQueryOptions(originalOptions(options));
    return prepareOptions(defaults);
  }) as QueryClient["defaultQueryOptions"];

  async function resume(
    targets: Entry[],
    generationByTarget?: Record<string, number>,
  ) {
    if (sessionPaused) return;
    for (const entry of targets) {
      const id = projectionId(entry.projection);
      entry.requiredGeneration = Math.max(
        entry.requiredGeneration,
        generationByTarget?.[id] ??
          generationByTarget?.[entry.projection.queryHash] ??
          0,
      );
      entry.suspended = false;
      const pending = entry.pendingSnapshot;
      entry.pendingSnapshot = undefined;
      if (pending) mirror(entry, pending.snapshot, pending.version);
    }
    if (targets.length && bridge.mode === "worker") {
      await bridge.control("RESUME", {
        operationId: operationId(),
        projectionIds: targets.map((entry) => projectionId(entry.projection)),
        requiredGeneration: Math.max(
          0,
          ...targets.map((entry) => entry.requiredGeneration),
        ),
      });
    }
  }
  async function control(
    type: "INVALIDATE" | "REFRESH",
    filters: QueryFilters & {
      refetchType?: "none" | "active" | "inactive" | "all";
    },
    options: Controls = {},
    completion: "dirty-applied" | "reads-settled" = "reads-settled",
  ) {
    const all = selected(filters);
    const refetchType =
      filters.refetchType ??
      (type === "INVALIDATE" ? "active" : (filters.type ?? "all"));
    const reads = all.filter(
      (entry) =>
        refetchType !== "none" &&
        !entry.query.isDisabled() &&
        !entry.query.isStatic() &&
        (refetchType === "all" ||
          (refetchType === "active") === entry.query.isActive()),
    );
    // Prefix targets preserve invalidation of resources that only another page
    // has instantiated. Predicates/exact filters are expanded on this page.
    const targets =
      !filters.queryKey && !filters.predicate
        ? [{ type: "user" }]
        : filters.queryKey && !filters.predicate && !filters.exact
          ? [{ type: "key-prefix", queryKey: filters.queryKey }]
          : all.map((entry) => ({
              type: "projection",
              projectionHash: projectionId(entry.projection),
            }));
    let result: { generationByTarget?: Record<string, number> } | undefined;
    let failed = false;
    try {
      result = (await bridge.control(type, {
        operationId: operationId(),
        source: "page",
        targets,
        selection: reads.map((entry) => projectionId(entry.projection)),
        refetchType,
        completion: refetchType === "none" ? "dirty-applied" : completion,
        throwOnError: options.throwOnError ?? false,
        cancelRefetch: options.cancelRefetch ?? true,
      })) as { generationByTarget?: Record<string, number> } | undefined;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A failed read still settles this operation's local mirror suspension.
      // Keep its original rejection if the port also fails during cleanup.
      await resume(all, result?.generationByTarget).catch((error) => {
        if (!failed) throw error;
      });
    }
    return all;
  }
  async function fetchManaged<
    TQueryFnData,
    TError = Error,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options: FetchQueryOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryKey,
      TPageParam
    >,
  ): Promise<TData> {
    await bridge.ready;
    if (bridge.mode !== "worker" || !runtimeProjection(options))
      return native.fetchQuery(options);
    if (sessionPaused)
      throw new DOMException("Session verification is pending", "AbortError");
    const defaulted = client.defaultQueryOptions(options);
    const query = client.getQueryCache().build(client, defaulted);
    // build() returns an existing seed-only Query without applying new options.
    // Register its metadata before deciding whether the imperative read is managed.
    query.setOptions(defaulted);
    const entry = entryFor(query as unknown as Query);
    if (!entry) return native.fetchQuery(options);
    const requestedStaleTime =
      typeof options.staleTime === "function"
        ? options.staleTime(query)
        : options.staleTime;
    const freshnessMs =
      typeof requestedStaleTime === "number" &&
      Number.isFinite(requestedStaleTime)
        ? Math.max(0, requestedStaleTime)
        : undefined;
    await resume([entry]);
    // Native infinite behavior assembles pages/pageParams around the page queryFn.
    // Passing a complete worker window here would nest InfiniteData as one page.
    if (isWindow(entry.projection))
      return query.fetch({
        ...defaulted,
        meta: {
          ...defaulted.meta,
          runtime: { ...runtimeMeta(defaulted), freshnessMs },
        },
      });
    // Query.fetch deliberately bypasses Infinity, but still owns the real
    // TanStack promise, cancellation rollback, error state and deduplication.
    return query.fetch({
      ...defaulted,
      queryFn: async ({ signal }) => {
        try {
          return await readProjection<TQueryFnData>(currentProjection(entry), {
            signal,
            requiredGeneration: entry.requiredGeneration,
            freshnessMs,
          });
        } catch (error) {
          throw runtimeMeta(options)?.mapError?.(error as Error) ?? error;
        }
      },
    });
  }
  client.fetchQuery = fetchManaged;
  client.prefetchQuery = ((
    options: Parameters<QueryClient["prefetchQuery"]>[0],
  ) =>
    bridge.mode === "fallback" || !runtimeProjection(options)
      ? native.prefetchQuery(options)
      : fetchManaged(options).then(
          () => undefined,
          () => undefined,
        )) as QueryClient["prefetchQuery"];
  client.ensureQueryData = ((
    options: Parameters<QueryClient["ensureQueryData"]>[0],
  ) => {
    if (bridge.mode === "fallback" || !runtimeProjection(options))
      return native.ensureQueryData(options);
    if (needsPermissionCheck(runtimeProjection(options)!))
      return fetchManaged(options);
    const query = client
      .getQueryCache()
      .find({ queryKey: options.queryKey, exact: true });
    if (query?.state.data === undefined) return fetchManaged(options);
    const projection = runtimeProjection(options);
    const freshness = projection
      ? Math.min(
          ...projection.resources.map(
            (resource) => policyFor(resource).freshnessMs,
          ),
        )
      : 0;
    if (
      options.revalidateIfStale &&
      (query.state.isInvalidated ||
        Date.now() - query.state.dataUpdatedAt >= freshness)
    ) {
      void fetchManaged(options).catch(() => undefined);
    }
    return Promise.resolve(query.state.data);
  }) as QueryClient["ensureQueryData"];

  client.invalidateQueries = (async (filters = {}, options = {}) => {
    if (bridge.mode !== "worker")
      return native.invalidateQueries(filters, options);
    if (pageOnly)
      return native.invalidateQueries(
        { ...unmanaged(filters), refetchType: filters.refetchType },
        options,
      );
    const managed = control("INVALIDATE", filters, options);
    await native.invalidateQueries(
      { ...filters, refetchType: "none" },
      options,
    );
    await Promise.all([
      managed,
      native.invalidateQueries(
        { ...unmanaged(filters), refetchType: filters.refetchType },
        options,
      ),
    ]);
  }) as QueryClient["invalidateQueries"];
  client.refetchQueries = (async (filters = {}, options = {}) => {
    if (bridge.mode !== "worker" || selected(filters).length === 0)
      return native.refetchQueries(filters, options);
    await Promise.all([
      control("REFRESH", filters, options),
      native.refetchQueries(unmanaged(filters), options),
    ]);
  }) as QueryClient["refetchQueries"];
  client.resetQueries = (async (filters = {}, options = {}) => {
    if (bridge.mode !== "worker") return native.resetQueries(filters, options);
    const targets = selected(filters);
    if (targets.length === 0) return native.resetQueries(filters, options);
    for (const entry of targets) entry.suspended = true;
    const pending = control(
      "REFRESH",
      { ...filters, refetchType: "active" },
      options,
    );
    for (const entry of targets) entry.query.reset();
    await Promise.all([
      pending,
      native.resetQueries(unmanaged(filters), options),
    ]);
  }) as QueryClient["resetQueries"];
  client.cancelQueries = ((filters = {}, options = {}) => {
    if (bridge.mode !== "worker") return native.cancelQueries(filters, options);
    const targets = selected(filters);
    if (targets.length === 0) return native.cancelQueries(filters, options);
    for (const entry of targets) entry.suspended = true;
    const local = native.cancelQueries(filters, options);
    const remote = bridge.control("CANCEL", {
      targetRequestIds: [],
      projectionIds: targets.map((entry) => projectionId(entry.projection)),
      suspendMirror: true,
    });
    return Promise.all([local, remote]).then(() => undefined);
  }) as QueryClient["cancelQueries"];
  client.clear = () => {
    permissionEpoch++;
    verifiedPermissions.clear();
    for (const entry of entries.values()) {
      entry.suspended = true;
      entry.unsubscribe?.();
      entry.subscriptionVersion++;
    }
    entries.clear();
    latestOwner.clear();
    writes.clear();
    native.clear();
  };

  const unsubscribeCache = client.getQueryCache().subscribe((event) => {
    if (disposed || mirroring) return;
    if (event.type === "removed") {
      const entry = entries.get(event.query.queryHash);
      entry?.unsubscribe?.();
      if (entry) entry.subscriptionVersion++;
      entries.delete(event.query.queryHash);
      return;
    }
    if (event.type === "observerAdded") allObservers.add(event.observer);
    if (event.type === "observerRemoved") allObservers.delete(event.observer);
    const entry = entryFor(event.query);
    if (!entry) return;
    if (event.type === "observerAdded") {
      entry.observers.add(event.observer);
      if (!entry.owners.size) void resume([entry]);
    } else if (event.type === "observerRemoved") {
      entry.observers.delete(event.observer);
    }
    if (
      (event.type === "observerAdded" ||
        event.type === "observerOptionsUpdated") &&
      !adjusting
    ) {
      adjusting = true;
      try {
        event.observer.setOptions(prepareOptions(event.observer.options));
      } finally {
        adjusting = false;
      }
    }
    syncSubscription(entry);
  });
  const unsubscribeMode = bridge.onMode(() => {
    for (const entry of entries.values()) {
      for (const observer of entry.observers)
        observer.setOptions(prepareOptions(observer.options));
      syncSubscription(entry);
    }
  });
  const unsubscribeReset = bridge.onSessionReset(() => {
    sessionPaused = true;
    permissionEpoch++;
    verifiedPermissions.clear();
    for (const entry of entries.values()) {
      entry.suspended = true;
      entry.requiredGeneration = 0;
      entry.revision = -1;
      entry.subscriptionVersion++;
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      entry.subscriptionKey = undefined;
      entry.owners.clear();
      entry.pendingSnapshot = undefined;
    }
    writes.clear();
    latestOwner.clear();
    for (const observer of allObservers)
      observer.setOptions(prepareOptions(observer.options));
    // The auth gate decides when cached rendering can be removed without
    // unmounting an unsaved editor. Cancellation immediately revokes writers.
    void native.cancelQueries();
  });

  const adapter: RuntimeQueryAdapter = {
    bridge,
    async resumeSession() {
      if (!sessionPaused) return;
      sessionPaused = false;
      for (const observer of allObservers)
        observer.setOptions(prepareOptions(observer.options));
      await resume([...entries.values()]);
      for (const entry of entries.values()) syncSubscription(entry);
    },
    async refresh(key, options = {}) {
      if (bridge.mode !== "worker") return;
      await control(
        "REFRESH",
        { queryKey: key, exact: true, refetchType: "all" },
        options,
        "dirty-applied",
      );
    },
    begin(filters, kind, ownerToken = operationId()) {
      const targets = kind === "alias" ? [] : selected(filters);
      const order = ++nextWriteOrder;
      writes.set(ownerToken, { kind, entries: new Set(targets), order });
      for (const query of client.getQueryCache().findAll(filters))
        latestOwner.set(query.queryHash, { ownerToken, order });
      for (const entry of targets) {
        entry.owners.add(ownerToken);
        entry.suspended = true;
      }
      return ownerToken;
    },
    write<T>(
      key: QueryKey,
      data: T | undefined,
      ownerToken: string,
    ): T | undefined {
      const owner = writes.get(ownerToken);
      if (!owner || sessionPaused) return client.getQueryData<T>(key);
      const hash = hashKey(key);
      const latest = latestOwner.get(hash);
      if (latest && latest.order > owner.order)
        return client.getQueryData<T>(key);
      latestOwner.set(hash, { ownerToken, order: owner.order });
      for (const entry of selected({ queryKey: key, exact: true })) {
        if (owner.kind !== "alias") {
          entry.owners.add(ownerToken);
          owner.entries.add(entry);
        }
      }
      return native.setQueryData<T>(key, data);
    },
    async settle(ownerToken) {
      const owner = writes.get(ownerToken);
      if (!owner) return;
      writes.delete(ownerToken);
      for (const entry of owner.entries) entry.owners.delete(ownerToken);
      await resume(
        [...owner.entries].filter((entry) => entry.owners.size === 0),
      );
      for (const entry of owner.entries) syncSubscription(entry);
    },
    async seed(key, data, options) {
      const current = options.isCurrent ?? (() => true);
      if (!current()) return false;
      const owner = adapter.begin(
        { queryKey: key, exact: true },
        "network-seed",
        options.ownerToken,
      );
      try {
        await client.cancelQueries({ queryKey: key, exact: true });
        if (!current()) return false;
        const query = client
          .getQueryCache()
          .find({ queryKey: key, exact: true });
        const entry = query && entryFor(query);
        if (entry && options.projection) {
          entry.unsubscribe?.();
          entry.unsubscribe = undefined;
          entry.subscriptionKey = undefined;
          entry.subscriptionVersion++;
          entry.revision = -1;
          entry.projection = options.projection;
          query.setOptions({
            ...query.options,
            meta: {
              ...query.meta,
              runtime: {
                ...runtimeMeta(query.options),
                projection: options.projection,
              },
            },
          });
        }
        adapter.write(key, data, owner);
        if (entry) syncSubscription(entry);
        return current();
      } finally {
        await adapter.settle(owner);
      }
    },
    pageInvalidation(action) {
      pageOnly = true;
      try {
        action();
      } finally {
        pageOnly = false;
      }
    },
    dispose() {
      disposed = true;
      unsubscribeCache();
      unsubscribeMode();
      unsubscribeReset();
      for (const entry of entries.values()) entry.unsubscribe?.();
      Object.assign(client, native);
      adapters.delete(client);
    },
  };
  adapters.set(client, adapter);
  return adapter;
}

/** Hook refetch bypasses QueryClient.refetchQueries, so its intent is explicit. */
export function wrapRuntimeRefetch<
  T extends { refetch: (options?: RefetchOptions) => Promise<unknown> },
>(client: QueryClient, key: QueryKey, result: T): T {
  const adapter = adapters.get(client);
  if (!adapter || adapter.bridge.mode !== "worker") return result;
  return {
    ...result,
    refetch: async (options?: RefetchOptions) => {
      await adapter.refresh(key, options);
      return result.refetch(options);
    },
  };
}

/** Hook facade keeps native select, placeholder and observer result semantics. */
export const useRuntimeQuery: typeof useQuery = ((
  options: Parameters<typeof useQuery>[0],
  queryClient?: QueryClient,
) => {
  const client = useQueryClient(queryClient);
  const result = useQuery(options, client);
  return runtimeProjection(options)
    ? wrapRuntimeRefetch(client, options.queryKey, result)
    : result;
}) as typeof useQuery;
export function beginRuntimeWrite(
  client: QueryClient,
  filters: QueryFilters,
  kind: LocalWriteKind = "optimistic",
  ownerToken?: string,
): string {
  return (
    adapters.get(client)?.begin(filters, kind, ownerToken) ??
    ownerToken ??
    operationId()
  );
}
export function writeRuntimeData<T>(
  client: QueryClient,
  key: QueryKey,
  data: T | undefined,
  ownerToken: string,
): T | undefined {
  const adapter = adapters.get(client);
  return adapter
    ? adapter.write<T>(key, data, ownerToken)
    : client.setQueryData<T>(key, data);
}
export function settleRuntimeWrite(
  client: QueryClient,
  ownerToken: string,
): Promise<void> {
  return adapters.get(client)?.settle(ownerToken) ?? Promise.resolve();
}
export function seedRuntimeQuery<T>(
  client: QueryClient,
  key: QueryKey,
  data: T,
  options: SeedOptions = {},
): Promise<boolean> {
  const adapter = adapters.get(client);
  if (adapter) return adapter.seed(key, data, options);
  return client.cancelQueries({ queryKey: key, exact: true }).then(() => {
    if (options.isCurrent && !options.isCurrent()) return false;
    client.setQueryData(key, data);
    return true;
  });
}
