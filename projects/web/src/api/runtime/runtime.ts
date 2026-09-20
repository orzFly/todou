import { serializeClientError } from "@todou/shared";
import type { CacheView } from "../event-rules.ts";
import {
  type CacheLimits,
  CompletedCache,
  type CompletedValue,
  payloadBytes,
} from "./cache.ts";
import {
  executeProjection,
  type ProjectionDescriptor,
  projectionId,
} from "./projections.ts";
import {
  type InvalidateOptions,
  type ReadOptions,
  RuntimeError,
  type RuntimeSnapshot,
  validateTargets,
} from "./protocol.ts";
import { readMutationAffects } from "./read-scope.ts";
import {
  canonical,
  type InvalidationTarget,
  keyStartsWith,
  policyFor,
  type ResourceDescriptor,
  resourceId,
  resourceScope,
} from "./resources.ts";
import {
  abortError,
  defaultTimers,
  type RuntimeTimer,
  type RuntimeTimers,
  retryDelay,
  shouldRetry,
} from "./scheduler.ts";
import {
  emptySnapshotStore,
  type SnapshotRecord,
  type SnapshotStore,
} from "./store.ts";

export interface PhysicalNetworkResult {
  promise: Promise<unknown>;
  transportSettled: Promise<void>;
}
export type RuntimeNetworkResult = Promise<unknown> | PhysicalNetworkResult;
export interface ResourceRuntimeOptions {
  network(
    resource: ResourceDescriptor,
    signal: AbortSignal,
  ): RuntimeNetworkResult;
  now?: () => number;
  timers?: RuntimeTimers;
  store?: SnapshotStore;
  limits?: Partial<CacheLimits>;
  origin?: string;
  accountId?: string;
  accountEpoch?: number;
  onError?: (error: unknown) => void;
}
interface Waiter {
  generation: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}
interface Flight {
  controller: AbortController;
  generation: number;
  epoch: number;
  abandoned: boolean;
  logicalSettled: boolean;
  timer?: RuntimeTimer;
  transportSettled: Promise<void>;
}
interface ResourceState {
  id: string;
  descriptor: ResourceDescriptor;
  generation: number;
  revision: number;
  waiters: Set<Waiter>;
  flight?: Flight;
  retryTimer?: RuntimeTimer;
  failures: number;
  restoring: boolean;
}
interface Subscription {
  id: string;
  projection: ProjectionState;
  enabled: boolean;
  visible: boolean;
  freshnessMs?: number;
  listener(snapshot: RuntimeSnapshot): void;
}
interface ProjectionState {
  id: string;
  descriptor: ProjectionDescriptor;
  dependencies: Set<string>;
  subscriptions: Set<string>;
  snapshot: RuntimeSnapshot;
  dirty: number;
  requestedDirty: number;
  payloadBytes: number;
  run?: Promise<void>;
  controller?: AbortController;
  accessedAt: number;
}

/** Worker-neutral owner of authorized completed values, generations and recipes. */
export class ResourceRuntime {
  private readonly resources = new Map<string, ResourceState>();
  private readonly projections = new Map<string, ProjectionState>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly operations = new Map<
    string,
    { generations: Record<string, number>; completion: Promise<void> }
  >();
  private readonly eventResources = new Map<number, Set<string>>();
  private readonly cache: CompletedCache;
  private readonly now: () => number;
  private readonly timers: RuntimeTimers;
  private readonly store: SnapshotStore;
  private readonly network: ResourceRuntimeOptions["network"];
  private readonly origin: string;
  private readonly onError?: (error: unknown) => void;
  private epoch: number;
  private accountId: string;
  private generation = 0;
  private revision = 0;
  private disposed = false;
  private epochController = new AbortController();
  private sweepTimer?: RuntimeTimer;
  readonly cacheView: CacheView;

  constructor(options: ResourceRuntimeOptions) {
    this.network = options.network;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.store = options.store ?? emptySnapshotStore;
    this.origin = options.origin ?? "";
    this.accountId = options.accountId ?? "";
    this.epoch = options.accountEpoch ?? 0;
    this.onError = options.onError;
    this.cache = new CompletedCache(options.limits, (id) => {
      for (const projection of this.projections.values()) {
        if (!projection.dependencies.has(id)) continue;
        projection.snapshot = {
          ...projection.snapshot,
          data: undefined,
          fetchedAt: 0,
          stale: true,
        };
        projection.payloadBytes = 0;
      }
    });
    this.cacheView = {
      getQueriesData: ({ queryKey }) =>
        [...this.projections.values()]
          .filter(
            (entry) =>
              keyStartsWith(entry.descriptor.queryKey, queryKey) &&
              entry.snapshot.data !== undefined,
          )
          .map((entry) => [entry.descriptor.queryKey, entry.snapshot.data]),
      getQueryData: (queryKey) =>
        [...this.projections.values()].find(
          (entry) =>
            canonical(entry.descriptor.queryKey) === canonical(queryKey) &&
            entry.snapshot.data !== undefined,
        )?.snapshot.data,
    };
    this.scheduleSweep();
  }

  get accountEpoch(): number {
    return this.epoch;
  }
  get stats(): {
    entries: number;
    bytes: number;
    resources: number;
    flights: number;
    waiters: number;
    projections: number;
    subscriptions: number;
  } {
    return {
      entries: this.cache.size,
      bytes: this.cache.totalBytes,
      resources: this.resources.size,
      flights: [...this.resources.values()].filter((state) => !!state.flight)
        .length,
      waiters: [...this.resources.values()].reduce(
        (total, state) => total + state.waiters.size,
        0,
      ),
      projections: this.projections.size,
      subscriptions: this.subscriptions.size,
    };
  }
  getProjections(): ProjectionDescriptor[] {
    return [...this.projections.values()].map((state) => state.descriptor);
  }
  getGeneration(descriptor: ResourceDescriptor): number {
    return this.state(descriptor).generation;
  }
  peek<T = unknown>(
    descriptor: ResourceDescriptor,
  ): (CompletedValue<T> & { stale: boolean }) | undefined {
    this.assertLive();
    const state = this.state(descriptor);
    const value = this.cache.get(state.id, this.now());
    return value
      ? ({ ...value, stale: !this.fresh(state, value) } as CompletedValue<T> & {
          stale: boolean;
        })
      : undefined;
  }

  read<T = unknown>(
    descriptor: ResourceDescriptor,
    options: ReadOptions = {},
  ): Promise<T> {
    try {
      this.assertLive();
      if (options.signal?.aborted) return Promise.reject(abortError());
      if (
        options.requiredGeneration !== undefined &&
        (!Number.isSafeInteger(options.requiredGeneration) ||
          options.requiredGeneration < 0)
      )
        throw new RuntimeError("protocol", "Invalid required generation");
      if (
        options.freshnessMs !== undefined &&
        (!Number.isFinite(options.freshnessMs) || options.freshnessMs < 0)
      )
        throw new RuntimeError("protocol", "Invalid freshness window");
      const state = this.state(descriptor);
      if (options.requiredGeneration !== undefined) {
        state.generation = Math.max(
          state.generation,
          options.requiredGeneration,
        );
        this.generation = Math.max(this.generation, options.requiredGeneration);
      }
      const cached = this.cache.get(state.id, this.now());
      if (options.forceFresh && (!state.flight || state.flight.logicalSettled))
        state.generation = ++this.generation;
      if (
        !options.forceFresh &&
        cached &&
        this.fresh(state, cached, options.freshnessMs)
      )
        return Promise.resolve(cached.data as T);
      const result = new Promise<T>((resolve, reject) => {
        const signal = options.signal;
        const timeout = this.timers.setTimeout(
          () =>
            this.settle(
              state,
              waiter,
              new RuntimeError("timeout", "Read deadline exceeded"),
              false,
            ),
          policyFor(descriptor).deadlineMs,
        );
        const cancelled = () => this.settle(state, waiter, abortError(), false);
        const waiter: Waiter = {
          generation: state.generation,
          resolve: (value) => resolve(value as T),
          reject,
          cleanup: () => {
            this.timers.clearTimeout(timeout);
            signal?.removeEventListener("abort", cancelled);
          },
        };
        state.waiters.add(waiter);
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) cancelled();
      });
      this.start(state);
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async readProjection<T = unknown>(
    descriptor: ProjectionDescriptor,
    options: ReadOptions = {},
  ): Promise<T> {
    this.assertLive();
    const projection = this.ensureProjection(descriptor);
    const dirty = projection.dirty;
    const initialRevision = projection.snapshot.revision;
    const epoch = this.epoch;
    const epochSignal = this.epochController.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    epochSignal.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted || epochSignal.aborted) controller.abort();
    const deadline = this.timers.setTimeout(abort, 30_000);
    try {
      const data = await executeProjection(
        descriptor,
        <R>(resource: ResourceDescriptor) => {
          this.depend(projection, this.state(resource).id);
          return this.read<R>(resource, {
            ...options,
            signal: controller.signal,
          });
        },
      );
      if (this.disposed || epoch !== this.epoch || epochSignal.aborted)
        throw new RuntimeError(
          "session-reset",
          "Session changed during projection read",
        );
      if (controller.signal.aborted)
        throw options.signal?.aborted
          ? abortError()
          : new RuntimeError("timeout", "Projection read deadline exceeded");
      if (
        projection.snapshot.revision <= initialRevision ||
        projection.snapshot.stale
      ) {
        projection.snapshot = {
          projectionHash: descriptor.queryHash,
          status: "success",
          fetchStatus: "idle",
          data,
          fetchedAt: this.now(),
          stale: projection.dirty !== dirty,
          revision: ++this.revision,
          generation: Math.max(
            0,
            ...[...projection.dependencies].map(
              (id) => this.cache.get(id)?.generation ?? 0,
            ),
          ),
        };
        projection.accessedAt = this.now();
        this.publish(projection);
        this.limitProjection(projection);
      }
      return data as T;
    } catch (error) {
      if (epochSignal.aborted || epoch !== this.epoch)
        throw new RuntimeError(
          "session-reset",
          "Session changed during projection read",
        );
      if (controller.signal.aborted && !options.signal?.aborted)
        throw new RuntimeError("timeout", "Projection read deadline exceeded");
      throw error;
    } finally {
      this.timers.clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      epochSignal.removeEventListener("abort", abort);
    }
  }

  subscribe(
    id: string,
    descriptor: ProjectionDescriptor,
    options: { enabled: boolean; visible: boolean; freshnessMs?: number },
    listener: (snapshot: RuntimeSnapshot) => void,
  ): () => void {
    this.assertLive();
    if (
      options.freshnessMs !== undefined &&
      (!Number.isFinite(options.freshnessMs) || options.freshnessMs < 0)
    )
      throw new RuntimeError("protocol", "Invalid freshness window");
    const key = projectionId(descriptor);
    const previous = this.subscriptions.get(id);
    if (previous?.projection.id !== key) this.unsubscribe(id);
    const state = this.ensureProjection(descriptor);
    if (state.subscriptions.size === 0)
      for (const dependency of state.dependencies) this.cache.pin(dependency);
    const subscription: Subscription = {
      id,
      projection: state,
      ...options,
      listener,
    };
    this.subscriptions.set(id, subscription);
    state.subscriptions.add(id);
    state.accessedAt = this.now();
    state.snapshot = { ...state.snapshot, stale: this.projectionStale(state) };
    this.deliver(subscription, state.snapshot);
    if (options.enabled && options.visible && state.snapshot.stale)
      void this.refreshProjection(state).catch(() => {});
    return () => {
      if (this.subscriptions.get(id) === subscription) this.unsubscribe(id);
    };
  }

  invalidate(
    targets: InvalidationTarget[],
    options: InvalidateOptions = {},
  ): Promise<void> {
    try {
      this.assertLive();
      validateTargets(targets);
      const prior = options.operationId
        ? this.operations.get(options.operationId)
        : undefined;
      if (prior) {
        options.onApplied?.(prior.generations);
        return options.completion === "dirty-applied"
          ? Promise.resolve()
          : prior.completion;
      }
      const selected = new Set<string>();
      const dirtyResources = new Set<string>();
      const seen =
        options.eventSeq === undefined
          ? undefined
          : (this.eventResources.get(options.eventSeq) ?? new Set<string>());
      for (const projection of this.projections.values()) {
        if (
          !targets.some((target) => this.matchesProjection(projection, target))
        )
          continue;
        if (!seen || [...projection.dependencies].some((id) => !seen.has(id))) {
          projection.dirty++;
          projection.snapshot = {
            ...projection.snapshot,
            stale: true,
            revision: ++this.revision,
          };
        }
        for (const dependency of projection.dependencies)
          dirtyResources.add(dependency);
        selected.add(projection.id);
      }
      for (const state of this.resources.values())
        if (targets.some((target) => this.matchesResource(state, target)))
          dirtyResources.add(state.id);
      const generations: Record<string, number> = {};
      for (const id of dirtyResources) {
        const state = this.resources.get(id);
        if (!state) continue;
        if (!seen?.has(id)) {
          state.generation = ++this.generation;
          seen?.add(id);
        }
        generations[id] = state.generation;
      }
      if (seen && options.eventSeq !== undefined) {
        this.eventResources.set(options.eventSeq, seen);
        this.trim(this.eventResources, 512);
      }
      for (const key of selected) {
        const state = this.projections.get(key);
        if (!state) continue;
        generations[state.descriptor.queryHash] =
          this.projectionGeneration(state);
        this.publish(state);
      }
      for (const target of targets)
        void Promise.resolve()
          .then(() => this.store.invalidateScope(target, this.generation))
          .catch(() => {});
      options.onApplied?.(generations);
      const reads: Promise<void>[] = [];
      const refetchType = options.refetchType ?? "active";
      if (refetchType !== "none")
        for (const key of selected) {
          const state = this.projections.get(key);
          if (
            !state ||
            (options.selection &&
              !options.selection.includes(state.id) &&
              !options.selection.includes(state.descriptor.queryHash))
          )
            continue;
          const active = this.visibleDemand(state);
          if (
            (refetchType === "active" && !active) ||
            (refetchType === "inactive" && active)
          )
            continue;
          reads.push(this.refreshProjection(state));
        }
      const completion = Promise.allSettled(reads).then((results) => {
        if (options.throwOnError) {
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
        }
      });
      // The dirty barrier is synchronous; reads settle independently of ACK.
      if (options.operationId) {
        this.operations.set(options.operationId, { generations, completion });
        this.trim(this.operations, 512);
      }
      void completion.catch(() => {});
      return options.completion === "dirty-applied" || refetchType === "none"
        ? Promise.resolve()
        : completion;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  setEpoch(epoch: number, accountId = this.accountId): void {
    if (!Number.isSafeInteger(epoch) || epoch < this.epoch)
      throw new RuntimeError("protocol", "Account epoch cannot move backwards");
    if (epoch === this.epoch && accountId === this.accountId) return;
    const previousAccount = this.accountId;
    const previousEpoch = this.epoch;
    this.epoch = epoch;
    this.accountId = accountId;
    this.retire();
    void Promise.resolve()
      .then(() => this.store.clearAccount(previousAccount, previousEpoch))
      .catch(() => {});
  }
  clear(): void {
    this.setEpoch(this.epoch + 1);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retire();
    if (this.sweepTimer !== undefined)
      this.timers.clearTimeout(this.sweepTimer);
  }

  /** Storage adapters cannot grant stale epochs/generations publication rights. */
  async restore(descriptor: ResourceDescriptor): Promise<void> {
    this.assertLive();
    const state = this.state(descriptor);
    if (state.restoring || !policyFor(descriptor).cacheable) return;
    state.restoring = true;
    const epoch = this.epoch;
    const generation = state.generation;
    const revision = state.revision;
    try {
      const records = await this.store.load(
        {
          origin: this.origin,
          apiMount: descriptor.apiMount,
          accountId: this.accountId,
          epoch,
          descriptor,
        },
        this.epochController.signal,
      );
      if (
        this.disposed ||
        epoch !== this.epoch ||
        this.resources.get(state.id) !== state ||
        generation !== state.generation ||
        revision !== state.revision
      )
        return;
      for (const record of records) {
        if (
          record.schemaVersion !== 1 ||
          record.origin !== this.origin ||
          record.apiMount !== descriptor.apiMount ||
          record.accountId !== this.accountId ||
          record.epoch !== epoch ||
          record.generation !== generation ||
          resourceId(record.descriptor, epoch) !== state.id ||
          !Number.isFinite(record.fetchedAt) ||
          record.fetchedAt > this.now()
        )
          continue;
        const value: CompletedValue = {
          descriptor,
          data: record.payload,
          fetchedAt: record.fetchedAt,
          generation,
          revision: ++this.revision,
          payloadBytes: payloadBytes(record.payload),
          accessedAt: this.now(),
        };
        if (this.cache.set(state.id, value)) {
          state.revision = value.revision;
          this.resourceUpdated(state);
        }
        break;
      }
    } catch {
      /* Storage failures are cache misses. */
    } finally {
      state.restoring = false;
    }
  }

  private assertLive(): void {
    if (this.disposed)
      throw new RuntimeError("session-reset", "Runtime is disposed");
  }
  private state(descriptor: ResourceDescriptor): ResourceState {
    const id = resourceId(descriptor, this.epoch);
    let state = this.resources.get(id);
    if (!state) {
      state = {
        id,
        descriptor: structuredClone(descriptor),
        generation: this.generation,
        revision: 0,
        waiters: new Set(),
        failures: 0,
        restoring: false,
      };
      this.resources.set(id, state);
    }
    return state;
  }
  private fresh(
    state: ResourceState,
    value: CompletedValue,
    freshnessMs = Number.POSITIVE_INFINITY,
  ): boolean {
    const policy = policyFor(state.descriptor);
    return (
      policy.cacheable &&
      value.generation >= state.generation &&
      this.now() - value.fetchedAt < Math.min(policy.freshnessMs, freshnessMs)
    );
  }
  private settle(
    state: ResourceState,
    waiter: Waiter,
    value: unknown,
    success: boolean,
  ): void {
    if (!state.waiters.delete(waiter)) return;
    waiter.cleanup();
    if (success) waiter.resolve(value);
    else waiter.reject(value);
    if (state.waiters.size === 0) {
      state.failures = 0;
      if (state.retryTimer !== undefined) {
        this.timers.clearTimeout(state.retryTimer);
        state.retryTimer = undefined;
      }
      if (state.flight && !state.flight.logicalSettled) {
        state.flight.abandoned = true;
        state.flight.controller.abort();
      }
    }
  }
  private start(state: ResourceState): void {
    if (
      this.disposed ||
      state.flight ||
      state.retryTimer !== undefined ||
      state.waiters.size === 0
    )
      return;
    const policy = policyFor(state.descriptor);
    const flight: Flight = {
      controller: new AbortController(),
      generation: state.generation,
      epoch: this.epoch,
      abandoned: false,
      logicalSettled: false,
      timer: undefined,
      transportSettled: Promise.resolve(),
    };
    state.flight = flight;
    flight.timer = this.timers.setTimeout(() => {
      flight.abandoned = true;
      flight.controller.abort();
      for (const waiter of [...state.waiters])
        this.settle(
          state,
          waiter,
          new RuntimeError("timeout", "Network read deadline exceeded"),
          false,
        );
      // Keep the physical slot until transport settles, even if it ignores abort.
    }, policy.deadlineMs);
    let request: Promise<unknown>;
    try {
      const result = this.network(state.descriptor, flight.controller.signal);
      if ("promise" in result) {
        request = result.promise;
        flight.transportSettled = Promise.resolve(result.transportSettled).then(
          () => undefined,
          () => undefined,
        );
      } else {
        request = result;
        flight.transportSettled = Promise.resolve(request).then(
          () => undefined,
          () => undefined,
        );
      }
    } catch (error) {
      request = Promise.reject(error);
    }
    const completed = Promise.resolve(request)
      .then(
        (data) => {
          flight.logicalSettled = true;
          if (
            flight.abandoned ||
            this.disposed ||
            flight.epoch !== this.epoch ||
            state.flight !== flight
          )
            return;
          state.failures = 0;
          const value: CompletedValue = {
            descriptor: state.descriptor,
            data,
            fetchedAt: this.now(),
            generation: flight.generation,
            revision: ++this.revision,
            payloadBytes: payloadBytes(data),
            accessedAt: this.now(),
          };
          state.revision = value.revision;
          const retained =
            policy.cacheable &&
            value.payloadBytes <= policy.maxPayloadBytes &&
            this.cache.set(state.id, value);
          if (retained) this.persist(state, value, flight.epoch);
          for (const waiter of [...state.waiters])
            if (waiter.generation <= flight.generation)
              this.settle(state, waiter, data, true);
          if (retained) this.resourceUpdated(state);
        },
        (error: unknown) => {
          flight.logicalSettled = true;
          if (
            flight.abandoned ||
            this.disposed ||
            flight.epoch !== this.epoch ||
            state.flight !== flight
          )
            return;
          const status = (error as { status?: number } | null)?.status;
          const name = (error as { name?: string } | null)?.name;
          if (
            status === 401 ||
            status === 403 ||
            status === 404 ||
            name === "MovedError" ||
            name === "GoneError"
          )
            this.cache.delete(state.id);
          if (
            shouldRetry(error, state.failures, policy) &&
            state.waiters.size > 0
          ) {
            const delay = retryDelay(state.failures++);
            state.retryTimer = this.timers.setTimeout(() => {
              state.retryTimer = undefined;
              this.start(state);
            }, delay);
          } else {
            state.failures = 0;
            for (const waiter of [...state.waiters])
              this.settle(state, waiter, error, false);
            try {
              this.onError?.(error);
            } catch {
              /* A host callback cannot strand reads. */
            }
          }
        },
      )
      .finally(() => {
        if (flight.timer) this.timers.clearTimeout(flight.timer);
      });
    void Promise.allSettled([completed, flight.transportSettled]).then(() => {
      if (state.flight === flight) {
        state.flight = undefined;
        this.start(state);
      }
      this.pruneResource(state);
    });
  }
  private persist(
    state: ResourceState,
    value: CompletedValue,
    epoch: number,
  ): void {
    const guard = () =>
      !this.disposed &&
      this.epoch === epoch &&
      state.generation === value.generation &&
      state.revision === value.revision &&
      this.cache.get(state.id) === value;
    if (!guard()) return;
    const record: SnapshotRecord = {
      schemaVersion: 1,
      origin: this.origin,
      apiMount: state.descriptor.apiMount,
      accountId: this.accountId,
      epoch,
      descriptor: state.descriptor,
      payload: value.data,
      fetchedAt: value.fetchedAt,
      generation: value.generation,
      payloadBytes: value.payloadBytes,
    };
    void Promise.resolve()
      .then(() => {
        if (guard()) return this.store.put(record, guard);
      })
      .then(() => {
        if (!guard())
          return this.store.invalidateScope(
            { type: "resource", resource: state.descriptor },
            state.generation,
          );
      })
      .catch(() => {});
  }
  private ensureProjection(descriptor: ProjectionDescriptor): ProjectionState {
    const id = projectionId(descriptor);
    let state = this.projections.get(id);
    if (state) {
      state.accessedAt = this.now();
      return state;
    }
    if (this.projections.size >= this.cache.limits.maxEntries) {
      const victim = [...this.projections.values()]
        .filter((entry) => !entry.subscriptions.size && !entry.run)
        .sort((a, b) => a.accessedAt - b.accessedAt)[0];
      if (victim) this.projections.delete(victim.id);
      else throw new RuntimeError("protocol", "Projection capacity exceeded");
    }
    state = {
      id,
      descriptor: structuredClone(descriptor),
      dependencies: new Set(),
      subscriptions: new Set(),
      dirty: 0,
      requestedDirty: 0,
      payloadBytes: 0,
      accessedAt: this.now(),
      snapshot: {
        projectionHash: descriptor.queryHash,
        status: "pending",
        fetchStatus: "idle",
        fetchedAt: 0,
        stale: true,
        revision: ++this.revision,
        generation: this.generation,
      },
    };
    this.projections.set(id, state);
    for (const resource of descriptor.resources)
      this.depend(state, this.state(resource).id);
    if (!descriptor.kind.startsWith("timeline-")) {
      const resource = descriptor.resources[0];
      const value = resource ? this.peek(resource) : undefined;
      if (value)
        state.snapshot = {
          ...state.snapshot,
          status: "success",
          data: value.data,
          fetchedAt: value.fetchedAt,
          stale: value.stale,
          generation: value.generation,
        };
      this.limitProjection(state);
    }
    return state;
  }
  private limitProjection(projection: ProjectionState): void {
    projection.payloadBytes =
      projection.snapshot.data === undefined
        ? 0
        : payloadBytes(projection.snapshot.data);
    if (
      [...projection.dependencies].some((id) => !this.cache.get(id)) ||
      projection.payloadBytes > this.cache.limits.maxEntryBytes
    ) {
      projection.snapshot = {
        ...projection.snapshot,
        data: undefined,
        stale: true,
      };
      projection.payloadBytes = 0;
    }
    this.trimProjectionPayloads();
  }
  private trimProjectionPayloads(): void {
    let total =
      this.cache.totalBytes +
      [...this.projections.values()].reduce(
        (sum, entry) => sum + entry.payloadBytes,
        0,
      );
    // Charge projections conservatively even when their objects currently share
    // references with raw values; later raw replacement must not hide old bodies.
    const victims = [...this.projections.values()].sort(
      (a, b) =>
        Number(a.subscriptions.size > 0) - Number(b.subscriptions.size > 0) ||
        a.accessedAt - b.accessedAt,
    );
    for (const projection of victims) {
      if (total <= this.cache.limits.maxBytes) break;
      total -= projection.payloadBytes;
      projection.payloadBytes = 0;
      projection.snapshot = {
        ...projection.snapshot,
        data: undefined,
        stale: true,
      };
    }
  }
  private depend(projection: ProjectionState, id: string): void {
    if (projection.dependencies.has(id)) return;
    projection.dependencies.add(id);
    if (projection.subscriptions.size > 0) this.cache.pin(id);
  }
  private projectionGeneration(projection: ProjectionState): number {
    return Math.max(
      0,
      ...[...projection.dependencies].map(
        (id) => this.resources.get(id)?.generation ?? 0,
      ),
    );
  }
  private projectionFreshness(projection: ProjectionState): number | undefined {
    let freshnessMs = Number.POSITIVE_INFINITY;
    for (const id of projection.subscriptions) {
      const subscription = this.subscriptions.get(id);
      if (subscription?.enabled && subscription.freshnessMs !== undefined)
        freshnessMs = Math.min(freshnessMs, subscription.freshnessMs);
    }
    return Number.isFinite(freshnessMs) ? freshnessMs : undefined;
  }
  private projectionStale(projection: ProjectionState): boolean {
    if (projection.snapshot.status !== "success") return true;
    for (const id of projection.dependencies) {
      const state = this.resources.get(id);
      const value = this.cache.get(id);
      if (
        !state ||
        !value ||
        !this.fresh(state, value, this.projectionFreshness(projection))
      )
        return true;
    }
    return false;
  }
  private visibleDemand(projection: ProjectionState): boolean {
    return [...projection.subscriptions].some((id) => {
      const subscription = this.subscriptions.get(id);
      return subscription?.enabled && subscription.visible;
    });
  }
  private refreshProjection(
    projection: ProjectionState,
    cachedOnly = false,
  ): Promise<void> {
    projection.requestedDirty = projection.dirty;
    if (projection.run) {
      if (projection.controller?.signal.aborted)
        return projection.run
          .catch(() => {})
          .then(() => {
            if (this.disposed || !this.projections.has(projection.id)) return;
            return this.refreshProjection(projection, cachedOnly);
          });
      return projection.run;
    }
    const epoch = this.epoch;
    const controller = new AbortController();
    projection.controller = controller;
    projection.snapshot = {
      ...projection.snapshot,
      fetchStatus: "fetching",
      revision: ++this.revision,
    };
    this.publish(projection);
    let timedOut = false;
    const deadline = this.timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30_000);
    const run = async () => {
      // Invalidations while a window is being rebuilt require another consistent
      // pass, bounded by the same overall deadline as an ordinary read.
      const started = this.now();
      for (;;) {
        const dirty = projection.dirty;
        const dependencies = new Set<string>();
        try {
          const data = await executeProjection(
            projection.descriptor,
            <T>(descriptor: ResourceDescriptor) => {
              const resource = this.state(descriptor);
              dependencies.add(resource.id);
              this.depend(projection, resource.id);
              if (cachedOnly) {
                const value = this.cache.get(resource.id);
                if (!value || !this.fresh(resource, value))
                  return Promise.reject(abortError());
                return Promise.resolve(value.data as T);
              }
              return this.read<T>(descriptor, {
                signal: controller.signal,
                freshnessMs: this.projectionFreshness(projection),
              });
            },
          );
          if (this.disposed || epoch !== this.epoch)
            throw new RuntimeError("session-reset", "Session changed");
          if (controller.signal.aborted)
            throw timedOut
              ? new RuntimeError("timeout", "Projection read deadline exceeded")
              : abortError();
          const stale =
            dirty !== projection.dirty ||
            [...dependencies].some((id) => {
              const state = this.resources.get(id);
              const value = this.cache.get(id);
              return (
                !!state &&
                !!value &&
                !this.fresh(state, value, this.projectionFreshness(projection))
              );
            });
          const fetchedAt = Math.min(
            this.now(),
            ...[...dependencies].map(
              (id) => this.cache.get(id)?.fetchedAt ?? this.now(),
            ),
          );
          const repeat = stale && projection.requestedDirty > dirty;
          projection.snapshot = {
            projectionHash: projection.descriptor.queryHash,
            status: "success",
            fetchStatus: repeat ? "fetching" : "idle",
            data,
            fetchedAt,
            stale,
            revision: ++this.revision,
            generation: Math.max(
              0,
              ...[...dependencies].map(
                (id) =>
                  this.cache.get(id)?.generation ??
                  this.resources.get(id)?.generation ??
                  0,
              ),
            ),
          };
          this.publish(projection);
          for (const id of projection.dependencies)
            if (!dependencies.has(id)) {
              if (projection.subscriptions.size)
                this.cache.unpin(id, this.now());
              projection.dependencies.delete(id);
            }
          this.limitProjection(projection);
          if (!repeat) return;
          if (this.now() - started >= 30_000)
            throw new RuntimeError(
              "timeout",
              "Projection read deadline exceeded",
            );
        } catch (error) {
          if (this.disposed || epoch !== this.epoch)
            throw new RuntimeError("session-reset", "Session changed");
          if (controller.signal.aborted && !timedOut) throw abortError();
          if (timedOut)
            error = new RuntimeError(
              "timeout",
              "Projection read deadline exceeded",
            );
          if (
            cachedOnly &&
            error instanceof Error &&
            error.name === "AbortError"
          ) {
            projection.snapshot = {
              ...projection.snapshot,
              fetchStatus: "idle",
            };
            this.publish(projection);
            return;
          }
          const failure = serializeClientError(error);
          const dropData =
            failure.status === 401 ||
            failure.status === 403 ||
            failure.status === 404 ||
            failure.kind === "moved" ||
            failure.kind === "gone";
          projection.snapshot = {
            ...projection.snapshot,
            status: "error",
            fetchStatus: "idle",
            error: failure,
            data: dropData ? undefined : projection.snapshot.data,
            stale: true,
            dropData,
            revision: ++this.revision,
            generation: this.projectionGeneration(projection),
          };
          this.publish(projection);
          throw error;
        }
      }
    };
    projection.run = run().finally(() => {
      this.timers.clearTimeout(deadline);
      if (projection.controller === controller) {
        projection.run = undefined;
        projection.controller = undefined;
      }
    });
    return projection.run;
  }
  private resourceUpdated(state: ResourceState): void {
    for (const projection of this.projections.values()) {
      if (!projection.dependencies.has(state.id)) continue;
      if (!projection.subscriptions.size && !projection.run) {
        projection.snapshot = {
          ...projection.snapshot,
          data: undefined,
          stale: true,
        };
        projection.payloadBytes = 0;
        continue;
      }
      if (projection.run) continue;
      // Hidden subscribers receive results caused by others, but never initiate
      // missing network reads just to assemble an incomplete composite window.
      if (
        [...projection.dependencies].every((id) => {
          const resource = this.resources.get(id);
          const cached = this.cache.get(id);
          return resource && cached && this.fresh(resource, cached);
        })
      )
        void this.refreshProjection(projection, true).catch(() => {});
    }
    this.trimProjectionPayloads();
  }
  private deliver(subscription: Subscription, snapshot: RuntimeSnapshot): void {
    try {
      subscription.listener({ ...snapshot });
    } catch {
      /* One bad consumer must not stop others. */
    }
  }
  private publish(projection: ProjectionState): void {
    for (const id of projection.subscriptions) {
      const subscription = this.subscriptions.get(id);
      if (subscription) this.deliver(subscription, projection.snapshot);
    }
  }
  private unsubscribe(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    this.subscriptions.delete(id);
    const projection = subscription.projection;
    projection.subscriptions.delete(id);
    projection.accessedAt = this.now();
    if (projection.subscriptions.size === 0) {
      projection.controller?.abort();
      for (const dependency of projection.dependencies)
        this.cache.unpin(dependency, this.now());
    }
  }
  private matchesProjection(
    projection: ProjectionState,
    target: InvalidationTarget,
  ): boolean {
    if (target.type === "read")
      return readMutationAffects(
        projection.descriptor.queryKey,
        projection.snapshot.data,
        target,
      );
    if (target.type === "projection")
      return (
        projection.id === target.projectionHash ||
        projection.descriptor.queryHash === target.projectionHash
      );
    if (target.type === "key-prefix")
      return keyStartsWith(projection.descriptor.queryKey, target.queryKey);
    return [...projection.dependencies].some((id) => {
      const state = this.resources.get(id);
      return state && this.matchesResource(state, target);
    });
  }
  private matchesResource(
    state: ResourceState,
    target: InvalidationTarget,
  ): boolean {
    if (target.type === "read") return false;
    if (
      state.descriptor.policyId === "spec-files-version" &&
      (target.type === "user" ||
        target.type === "project" ||
        target.type === "issue")
    )
      return false;
    if (target.type === "user") return true;
    if (target.type === "resource")
      return resourceId(target.resource, this.epoch) === state.id;
    const scope = resourceScope(state.descriptor);
    if (target.type === "project") {
      if (target.slug !== undefined) return scope.slug === target.slug;
      // Project IDs cannot be guessed from slugs. Use authorized project data;
      // if the mapping was evicted, conservative invalidation is required.
      const projects = this.cacheView.getQueryData(["projects"]);
      if (Array.isArray(projects)) {
        const project = projects.find(
          (item) => String(item.id) === String(target.id),
        );
        if (project) return scope.slug === project.slug;
      }
      return scope.slug !== undefined;
    }
    return (
      target.type === "issue" &&
      scope.slug === target.slug &&
      scope.issueNumber === target.number
    );
  }
  private retire(): void {
    this.epochController.abort();
    this.epochController = new AbortController();
    for (const projection of this.projections.values()) {
      projection.controller?.abort();
      projection.snapshot = {
        ...projection.snapshot,
        data: undefined,
        status: "pending",
        fetchStatus: "idle",
        stale: true,
        dropData: true,
        revision: ++this.revision,
      };
      this.publish(projection);
    }
    for (const state of this.resources.values()) {
      if (state.retryTimer !== undefined)
        this.timers.clearTimeout(state.retryTimer);
      if (state.flight) {
        state.flight.abandoned = true;
        state.flight.controller.abort();
        if (state.flight.timer) this.timers.clearTimeout(state.flight.timer);
      }
      for (const waiter of [...state.waiters])
        this.settle(
          state,
          waiter,
          new RuntimeError("session-reset", "Session changed"),
          false,
        );
    }
    this.subscriptions.clear();
    this.projections.clear();
    this.resources.clear();
    this.cache.clear();
    this.operations.clear();
    this.eventResources.clear();
  }
  private pruneResource(state: ResourceState): void {
    if (
      state.flight ||
      state.waiters.size ||
      state.retryTimer !== undefined ||
      this.cache.get(state.id)
    )
      return;
    if (
      [...this.projections.values()].some((projection) =>
        projection.dependencies.has(state.id),
      )
    )
      return;
    if (this.resources.get(state.id) === state) this.resources.delete(state.id);
  }
  private scheduleSweep(): void {
    this.sweepTimer = this.timers.setTimeout(
      () => {
        if (this.disposed) return;
        this.cache.sweep(this.now());
        for (const [id, projection] of this.projections)
          if (
            !projection.subscriptions.size &&
            !projection.run &&
            (this.now() - projection.accessedAt >= this.cache.limits.idleMs ||
              [...projection.dependencies].some(
                (dependency) => !this.cache.get(dependency),
              ))
          )
            this.projections.delete(id);
        for (const state of this.resources.values()) this.pruneResource(state);
        this.scheduleSweep();
      },
      Math.max(1, Math.min(this.cache.limits.idleMs, 60_000)),
    );
  }
  private trim<K, V>(map: Map<K, V>, max: number): void {
    while (map.size > max) {
      const first = map.keys().next();
      if (first.done) break;
      map.delete(first.value);
    }
  }
}
export function createResourceRuntime(
  options: ResourceRuntimeOptions,
): ResourceRuntime {
  return new ResourceRuntime(options);
}
