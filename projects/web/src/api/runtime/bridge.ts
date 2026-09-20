import { deserializeClientError, type Me, TodouClient } from "@todou/shared";
import {
  type AuthControl,
  AuthFenceError,
  type AuthMarker,
  browserAuthControl,
  markerToken,
  runtimeId,
} from "./auth-control.ts";
import { deferred } from "./deferred.ts";
import type { ProjectionDescriptor } from "./projections.ts";
import {
  PROTOCOL_VERSION,
  type ReadOptions,
  RuntimeError,
  type RuntimeSnapshot,
  type ServerMessage,
} from "./protocol.ts";
import type { ResourceDescriptor } from "./resources.ts";
import {
  HANDSHAKE_MS,
  PORT_LEASE_MS,
  type RuntimeFrame,
  type RuntimePort,
  VISIBLE_PROBE_MS,
} from "./session.ts";

export type RuntimeMode = "connecting" | "worker" | "fallback";
export type RuntimeControl =
  | "REFRESH"
  | "INVALIDATE"
  | "CANCEL"
  | "RESUME"
  | "SESSION_RESET";
export type { RuntimeFrame } from "./session.ts";
export interface RuntimeWorker {
  port: RuntimePort;
  onerror: ((event: Event) => void) | null;
}
export interface RuntimeBridgeOptions {
  apiMount?: string;
  buildId?: string;
  clientOrigin?: string;
  onCanonicalSlug?: (requested: string, canonical: string) => void;
  bootstrapFallback?: () => Promise<Me>;
  /** Deterministic harness seams; production probes actual browser capabilities. */
  workerFactory?: (name: string) => RuntimeWorker;
  authControl?: AuthControl;
  events?: EventTarget;
  document?: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  online?: () => boolean;
  pageOrigin?: string;
  navigate?: (url: string) => void;
}
export interface RuntimeBridge {
  readonly mode: RuntimeMode;
  readonly ready: Promise<void>;
  bootstrap(): Promise<Me>;
  read<T = unknown>(
    resource: ResourceDescriptor,
    options?: ReadOptions,
  ): Promise<T>;
  readProjection<T = unknown>(
    projection: ProjectionDescriptor,
    options?: ReadOptions,
  ): Promise<T>;
  subscribe(
    projection: ProjectionDescriptor,
    options: { enabled: boolean; visible?: boolean; freshnessMs?: number },
    listener: (snapshot: RuntimeSnapshot) => void,
  ): () => void;
  control(
    type: RuntimeControl,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  onFrame(listener: (frame: RuntimeFrame) => void): () => void;
  onSessionReset(listener: (reason: string) => void): () => void;
  onMode(listener: (mode: RuntimeMode) => void): () => void;
  authTransition<T>(action: () => Promise<T>): Promise<T>;
  authRedirect(url: string): Promise<never>;
  captureAuthFence(): string | undefined;
  assertAuthFence(token: string | undefined): void;
  dispose(): void;
}

type Pending = {
  type: string;
  private: boolean;
  token?: string;
  completion: "ack" | "result" | "identity" | "ready" | "pong";
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof globalThis.setTimeout>;
  cleanup?: () => void;
};
type BridgeSubscription = {
  projection: ProjectionDescriptor;
  options: { enabled: boolean; visible?: boolean; freshnessMs?: number };
  listener: (snapshot: RuntimeSnapshot) => void;
  revision: number;
};

class PageRuntimeBridge implements RuntimeBridge {
  mode: RuntimeMode = "connecting";
  readonly ready: Promise<void>;
  private readonly auth: AuthControl;
  private readonly apiMount: string;
  private readonly buildId: string;
  private readonly clientOrigin: string;
  private readonly pageOrigin: string;
  private readonly events?: EventTarget;
  private readonly document?: RuntimeBridgeOptions["document"];
  private readonly direct: TodouClient;
  private worker?: RuntimeWorker;
  private generation = "";
  private portId = "";
  private epoch = 0;
  private recovery?: Promise<void>;
  private validationVersion = 0;
  private handlingAuth = false;
  private nextId = 0;
  private rebuilt = false;
  private connecting?: Promise<void>;
  private bootstrapping?: Promise<Me>;
  private identityToken?: string;
  private admittedIdentity = false;
  private suspended = false;
  private disposed = false;
  private heartbeat?: ReturnType<typeof globalThis.setInterval>;
  private missedProbes = 0;
  private lastLease = 0;
  private markerRemoved = false;
  private pending = new Map<string, Pending>();
  private subscriptions = new Map<string, BridgeSubscription>();
  private frameListeners = new Set<(frame: RuntimeFrame) => void>();
  private resetListeners = new Set<(reason: string) => void>();
  private modeListeners = new Set<(mode: RuntimeMode) => void>();
  private releaseAuth: () => void;

  private readonly options: RuntimeBridgeOptions;
  constructor(options: RuntimeBridgeOptions) {
    this.options = options;
    this.apiMount =
      options.apiMount ?? `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
    this.buildId = options.buildId ?? __TODOU_VERSION__;
    this.clientOrigin = options.clientOrigin ?? runtimeId();
    this.pageOrigin =
      options.pageOrigin ?? globalThis.location?.origin ?? "http://localhost";
    this.auth = options.authControl ?? browserAuthControl(this.apiMount);
    this.events =
      options.events ?? (typeof window === "undefined" ? undefined : window);
    this.document =
      options.document ??
      (typeof document === "undefined" ? undefined : document);
    this.direct = new TodouClient({
      baseUrl: this.apiMount.slice(0, -4),
      batch: false,
    });
    this.releaseAuth = this.auth.subscribe((marker) => {
      if (marker === null && this.auth.available) this.markerRemoved = true;
      this.revoke(
        marker?.phase === "begin" ? "auth-transition" : "auth-settled",
      );
      let stored: AuthMarker | null;
      try {
        stored = this.auth.read();
      } catch {
        this.fallback();
        return;
      }
      if (markerToken(marker) !== markerToken(stored)) {
        // A fallback peer could revoke by channel but could not persist a
        // marker. This page can no longer enforce the durable delivery fence.
        void this.fence(marker)
          .finally(() => this.fallback())
          .catch(() => {});
        return;
      }
      if (this.mode === "worker")
        void this.fence(marker).catch(() => this.fail());
      if (!this.handlingAuth && marker?.phase !== "begin" && !this.suspended)
        void this.bootstrap().catch(() => {});
    });
    this.events?.addEventListener("pagehide", this.suspend);
    this.events?.addEventListener("freeze", this.suspend);
    this.events?.addEventListener("pageshow", this.resume);
    this.events?.addEventListener("resume", this.resume);
    this.events?.addEventListener("online", this.visibility);
    this.events?.addEventListener("offline", this.visibility);
    this.document?.addEventListener("visibilitychange", this.visibility);
    this.ready = this.start();
  }

  private get visible(): boolean {
    return this.document?.visibilityState !== "hidden" && !this.suspended;
  }
  private get online(): boolean {
    return this.options.online?.() ?? globalThis.navigator?.onLine !== false;
  }

  private async start(): Promise<void> {
    if (
      !this.auth.supported ||
      (!this.options.workerFactory && typeof SharedWorker !== "function")
    ) {
      this.setMode("fallback");
      return;
    }
    try {
      await this.connect();
    } catch {
      await this.fail();
    }
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const connection = (async () => {
      this.closePort();
      this.setMode("connecting");
      const name = `todou-runtime:v${PROTOCOL_VERSION}:${this.apiMount}:${this.buildId}`;
      // The literal URL and type allow Vite to emit a loadable module worker.
      const worker = this.options.workerFactory
        ? this.options.workerFactory(name)
        : (new SharedWorker(new URL("./shared-worker.ts", import.meta.url), {
            type: "module",
            name,
          }) as unknown as RuntimeWorker);
      this.worker = worker;
      worker.onerror = () => {
        void this.fail();
      };
      worker.port.onmessageerror = () => {
        void this.fail();
      };
      worker.port.onmessage = (event) => this.receive(event.data);
      worker.port.start();
      await this.request(
        "HELLO",
        {
          buildId: this.buildId,
          apiMount: this.apiMount,
          pageOrigin: this.pageOrigin,
          clientOrigin: this.clientOrigin,
        },
        "ready",
        false,
        undefined,
        HANDSHAKE_MS,
      );
      if (this.disposed || this.suspended || this.worker !== worker)
        throw new RuntimeError("cancelled", "Connection was retired");
      this.setMode("worker");
      await this.request(
        "VISIBILITY",
        {
          visible: this.visible,
          online: this.online,
          marker: this.readMarker(),
        },
        "ack",
        false,
      );
      this.lastLease = Date.now();
      this.missedProbes = 0;
      clearInterval(this.heartbeat);
      this.heartbeat = globalThis.setInterval(() => {
        if (!this.visible || this.mode !== "worker") return;
        void this.request(
          "PING",
          { nonce: runtimeId() },
          "pong",
          false,
          undefined,
          VISIBLE_PROBE_MS,
        )
          .then(() => {
            this.missedProbes = 0;
            this.lastLease = Date.now();
          })
          .catch(() => {
            if (this.visible && ++this.missedProbes >= 2) void this.fail();
          });
      }, VISIBLE_PROBE_MS);
    })();
    this.connecting = connection;
    void connection
      .finally(() => {
        if (this.connecting === connection) this.connecting = undefined;
      })
      .catch(() => {});
    return connection;
  }

  async bootstrap(): Promise<Me> {
    await this.ready;
    if (this.disposed)
      throw new RuntimeError("cancelled", "Runtime bridge disposed");
    if (this.suspended)
      throw new RuntimeError("session-reset", "Page is suspended");
    if (this.bootstrapping) return this.bootstrapping;
    const bootstrap = (async () => {
      if (this.mode === "connecting") await this.connecting;
      if (this.handlingAuth && this.readMarker()?.phase === "begin")
        throw new AuthFenceError();
      if (this.markerRemoved && this.auth.supported) {
        await this.auth.restoreMarker(
          () => this.verifyRecovery(),
          (marker) => this.fence(marker),
        );
        this.markerRemoved = false;
      }
      if (this.auth.supported && this.readMarker()?.phase === "begin") {
        await this.auth.recover({
          verify: () => this.verifyRecovery(),
          fence: (marker) => this.fence(marker),
        });
      }
      const validationVersion = this.validationVersion;
      const portId = this.portId;
      let token = this.captureAuthFence();
      let me: Me;
      if (this.mode === "worker") {
        try {
          me = (await this.request(
            "AUTH_BOOTSTRAP",
            { marker: this.readMarker() },
            "identity",
            false,
          )) as Me;
        } catch (error) {
          // A new page cannot observe an earlier storage removal event. A
          // living worker refusing its null marker supplies that evidence;
          // recover under the auth lock and verify online before retrying.
          if (
            !this.auth.supported ||
            this.readMarker() !== null ||
            (error as { kind?: string })?.kind !== "session-reset"
          )
            throw error;
          await this.auth.restoreMarker(
            () => this.verifyRecovery(),
            (marker) => this.fence(marker),
          );
          token = this.captureAuthFence();
          me = (await this.request(
            "AUTH_BOOTSTRAP",
            { marker: this.readMarker() },
            "identity",
            false,
          )) as Me;
        }
      } else {
        me = await (this.options.bootstrapFallback?.() ?? this.direct.me());
      }
      if (token !== undefined) this.assertFence(token);
      if (
        this.disposed ||
        this.suspended ||
        portId !== this.portId ||
        (this.mode !== "worker" && validationVersion !== this.validationVersion)
      )
        throw new AuthFenceError();
      this.identityToken = token;
      this.admittedIdentity = true;
      if (this.mode === "worker") {
        for (const [id, subscription] of this.subscriptions)
          this.sendSubscription(id, subscription);
      }
      return me;
    })();
    this.bootstrapping = bootstrap;
    try {
      return await bootstrap;
    } finally {
      if (this.bootstrapping === bootstrap) this.bootstrapping = undefined;
    }
  }

  async read<T = unknown>(
    resource: ResourceDescriptor,
    options: ReadOptions = {},
  ): Promise<T> {
    return this.readRequest<T>({ resource }, options);
  }
  async readProjection<T = unknown>(
    projection: ProjectionDescriptor,
    options: ReadOptions = {},
  ): Promise<T> {
    return this.readRequest<T>({ projection }, options);
  }

  private async readRequest<T>(
    descriptor: Record<string, unknown>,
    options: ReadOptions,
  ): Promise<T> {
    if (options.signal?.aborted)
      throw new DOMException("The operation was aborted", "AbortError");
    await this.ready;
    if (this.mode !== "worker")
      throw new RuntimeError(
        "session-reset",
        "Worker unavailable; use the page query path",
      );
    if (this.identityToken === undefined) await this.bootstrap();
    const data = await this.request(
      "READ_FRESH",
      {
        ...descriptor,
        forceFresh: options.forceFresh,
        requiredGeneration: options.requiredGeneration,
        freshnessMs: options.freshnessMs,
      },
      "result",
      true,
      options.signal,
    );
    return data as T;
  }

  subscribe(
    projection: ProjectionDescriptor,
    options: { enabled: boolean; visible?: boolean; freshnessMs?: number },
    listener: (snapshot: RuntimeSnapshot) => void,
  ): () => void {
    const id = runtimeId();
    const subscription: BridgeSubscription = {
      projection,
      options,
      listener,
      revision: -1,
    };
    this.subscriptions.set(id, subscription);
    void this.ready
      .then(async () => {
        if (this.mode !== "worker" || !this.subscriptions.has(id)) return;
        if (this.identityToken === undefined) await this.bootstrap();
        else this.sendSubscription(id, subscription);
      })
      .catch(() => {});
    return () => {
      if (!this.subscriptions.delete(id)) return;
      if (this.mode === "worker" && this.identityToken !== undefined)
        void this.request(
          "UNSUBSCRIBE",
          { subscriptionId: id },
          "ack",
          true,
        ).catch(() => {});
    };
  }

  private sendSubscription(id: string, subscription: BridgeSubscription): void {
    if (
      !this.subscriptions.has(id) ||
      this.mode !== "worker" ||
      this.identityToken === undefined
    )
      return;
    void this.request(
      "SUBSCRIBE",
      {
        subscriptionId: id,
        projection: subscription.projection,
        enabled: subscription.options.enabled,
        visible: subscription.options.visible ?? true,
        freshnessMs: subscription.options.freshnessMs,
      },
      "ack",
      true,
    ).catch(() => {});
  }

  async control(
    type: RuntimeControl,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    await this.ready;
    if (this.mode !== "worker") return undefined;
    const privateMessage = type !== "SESSION_RESET";
    if (privateMessage && this.identityToken === undefined)
      await this.bootstrap();
    const completion =
      (type === "REFRESH" || type === "INVALIDATE") &&
      payload.completion !== "dirty-applied" &&
      payload.refetchType !== "none"
        ? "result"
        : "ack";
    return this.request(
      type,
      {
        ...payload,
        ...(type === "SESSION_RESET" ? { expectedEpoch: this.epoch } : {}),
        ...((type === "REFRESH" || type === "INVALIDATE") &&
        !payload.operationId
          ? { operationId: runtimeId() }
          : {}),
      },
      completion,
      privateMessage,
    );
  }

  onFrame(listener: (frame: RuntimeFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onSessionReset(listener: (reason: string) => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }
  onMode(listener: (mode: RuntimeMode) => void): () => void {
    this.modeListeners.add(listener);
    return () => this.modeListeners.delete(listener);
  }

  async authTransition<T>(action: () => Promise<T>): Promise<T> {
    await this.ready;
    this.handlingAuth = true;
    try {
      return await this.auth.transition(action, {
        fence: (marker) => this.fence(marker),
        confirm: () => this.confirmAuth(),
        recover: () => this.verifyRecovery(),
      });
    } finally {
      this.handlingAuth = false;
    }
  }

  async authRedirect(url: string): Promise<never> {
    return this.authTransition(async () => {
      (
        this.options.navigate ??
        ((target) => globalThis.location.assign(target))
      )(url);
      return deferred<never>().promise;
    });
  }

  private async confirmAuth(): Promise<void> {
    try {
      await this.bootstrap();
    } catch (error) {
      // A successful logout has no /me. Network errors never reopen the fence.
      if ((error as { status?: number })?.status !== 401) throw error;
    }
  }

  private async verifyRecovery(): Promise<void> {
    try {
      await (this.options.bootstrapFallback?.() ?? this.direct.me());
    } catch (error) {
      if ((error as { status?: number })?.status !== 401) throw error;
    }
  }

  private async fence(marker: AuthMarker | null): Promise<void> {
    if (this.mode !== "worker" || !marker) return;
    await this.request(
      "AUTH_TRANSITION",
      { ...marker, expectedEpoch: this.epoch, marker },
      "ack",
      false,
    );
  }

  private readMarker(): AuthMarker | null {
    try {
      return this.auth.read();
    } catch {
      if (this.mode === "worker") this.fallback();
      return null;
    }
  }

  private assertFence(token: string): void {
    try {
      this.auth.assert(token);
    } catch (error) {
      this.revoke("auth-transition");
      try {
        this.auth.read();
      } catch {
        this.fallback();
      }
      throw error;
    }
  }

  captureAuthFence(): string | undefined {
    if (!this.auth.available) return undefined;
    return this.auth.capture();
  }

  assertAuthFence(token: string | undefined): void {
    if (token !== undefined) this.assertFence(token);
  }

  private request(
    type: string,
    payload: Record<string, unknown>,
    completion: Pending["completion"],
    privateMessage: boolean,
    signal?: AbortSignal,
    timeout = 30_000,
  ): Promise<unknown> {
    if (!this.worker || this.disposed)
      return Promise.reject(
        new RuntimeError("session-reset", "Runtime is disconnected"),
      );
    if (signal?.aborted)
      return Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      );
    let token: string | undefined;
    if (privateMessage) {
      try {
        token = this.auth.capture();
        if (this.identityToken !== token) throw new AuthFenceError();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const requestId = String(++this.nextId);
    const { promise, resolve, reject } = deferred<unknown>();
    const timer = globalThis.setTimeout(() => {
      this.settle(
        requestId,
        new RuntimeError("timeout", `${type} timed out`),
        true,
      );
      if (privateMessage)
        void this.request(
          "CANCEL",
          { targetRequestIds: [requestId] },
          "ack",
          false,
        ).catch(() => {});
    }, timeout);
    const pending: Pending = {
      type,
      private: privateMessage,
      token,
      completion,
      resolve,
      reject,
      timer,
    };
    if (signal) {
      const abort = () => {
        this.settle(
          requestId,
          new DOMException("The operation was aborted", "AbortError"),
          true,
        );
        void this.request(
          "CANCEL",
          { targetRequestIds: [requestId] },
          "ack",
          false,
        ).catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      pending.cleanup = () => signal.removeEventListener("abort", abort);
    }
    this.pending.set(requestId, pending);
    try {
      this.worker!.port.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        ...(type === "HELLO"
          ? {}
          : {
              runtimeGeneration: this.generation,
              portId: this.portId,
              accountEpoch: this.epoch,
            }),
        ...payload,
        type,
        requestId,
      });
    } catch (error) {
      this.settle(requestId, error, true);
      void this.fail();
    }
    return promise;
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as ServerMessage;
    if (
      message.protocolVersion !== PROTOCOL_VERSION ||
      typeof message.requestId !== "string" ||
      typeof message.runtimeGeneration !== "string" ||
      typeof message.portId !== "string" ||
      !Number.isSafeInteger(message.accountEpoch) ||
      message.accountEpoch < 0
    )
      return;
    if (message.type === "READY") {
      if (this.pending.get(message.requestId)?.completion !== "ready") return;
      this.generation = message.runtimeGeneration;
      this.portId = message.portId;
      this.epoch = message.accountEpoch;
      this.settle(message.requestId, undefined);
      return;
    }
    if (
      message.runtimeGeneration !== this.generation ||
      message.portId !== this.portId
    )
      return;
    if (message.type === "SESSION_RESET") {
      if (message.accountEpoch < this.epoch) return;
      this.epoch = message.accountEpoch;
      this.revoke(message.reason);
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (message.type === "IDENTITY") {
      if (
        pending?.completion !== "identity" ||
        message.accountEpoch < this.epoch
      )
        return;
      this.epoch = message.accountEpoch;
      this.settle(message.requestId, message.me);
      return;
    }
    // Auth controls can ACK a newly advanced epoch; private frames cannot.
    if (message.accountEpoch !== this.epoch) return;
    try {
      if (pending?.private && pending.token !== undefined)
        this.assertFence(pending.token);
      if (
        message.type === "SNAPSHOT" ||
        message.type === "FRAME" ||
        message.type === "CANONICAL_SLUG"
      ) {
        if (this.identityToken === undefined) return;
        this.assertFence(this.identityToken);
      }
    } catch (error) {
      if (pending) this.settle(message.requestId, error, true);
      return;
    }
    switch (message.type) {
      case "ACK":
        if (pending?.completion === "ack")
          this.settle(message.requestId, {
            generationByTarget: message.generationByTarget,
          });
        break;
      case "RESULT":
        if (pending?.completion === "result")
          this.settle(message.requestId, message.data);
        break;
      case "ERROR":
        if (
          pending &&
          message.error &&
          typeof message.error.message === "string"
        )
          this.settle(
            message.requestId,
            deserializeClientError(message.error),
            true,
          );
        break;
      case "PONG":
        if (pending?.completion === "pong")
          this.settle(message.requestId, undefined);
        break;
      case "SNAPSHOT": {
        const subscription = this.subscriptions.get(message.subscriptionId);
        const snapshot = message.snapshot;
        if (
          !subscription ||
          !snapshot ||
          snapshot.projectionHash !== subscription.projection.queryHash ||
          !Number.isSafeInteger(snapshot.revision) ||
          snapshot.revision <= subscription.revision
        )
          return;
        subscription.revision = snapshot.revision;
        subscription.listener(snapshot);
        break;
      }
      case "FRAME":
        if (
          !Array.isArray(message.invalidations) ||
          !Number.isSafeInteger(message.runtimeEventSeq) ||
          message.origin === this.clientOrigin
        )
          return;
        for (const listener of this.frameListeners) listener(message);
        break;
      case "CANONICAL_SLUG":
        if (
          pending &&
          typeof message.requested === "string" &&
          typeof message.canonical === "string"
        )
          this.options.onCanonicalSlug?.(message.requested, message.canonical);
        break;
      default:
        return;
    }
  }

  private settle(requestId: string, value: unknown, failed = false): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (failed) pending.reject(value);
    else pending.resolve(value);
  }

  private revoke(reason: string): void {
    this.validationVersion++;
    this.identityToken = undefined;
    this.bootstrapping = undefined;
    for (const subscription of this.subscriptions.values())
      subscription.revision = -1;
    for (const [id, pending] of this.pending)
      if (pending.private)
        this.settle(id, new RuntimeError("session-reset", reason), true);
    // Initial transport selection has no private session to revoke. Pausing
    // the page adapter here would prevent its first online /me gate from
    // mounting after fallback. Established identities retain every reset.
    if (
      !this.admittedIdentity &&
      (reason === "worker-restarted" || reason === "fallback")
    )
      return;
    for (const listener of this.resetListeners) listener(reason);
  }

  private setMode(mode: RuntimeMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    for (const listener of this.modeListeners) listener(mode);
  }

  private fail(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.disposed || this.suspended || this.mode === "fallback")
      return Promise.resolve();
    const recovery = (async () => {
      this.closePort();
      this.revoke("worker-restarted");
      if (this.rebuilt) {
        this.fallback();
        return;
      }
      this.rebuilt = true;
      this.connecting = undefined;
      try {
        await this.connect();
        void this.bootstrap().catch(() => {});
      } catch {
        this.fallback();
      }
    })();
    this.recovery = recovery;
    void recovery
      .finally(() => {
        if (this.recovery === recovery) this.recovery = undefined;
      })
      .catch(() => {});
    return recovery;
  }

  private fallback(): void {
    if (this.mode === "fallback") return;
    this.closePort();
    this.setMode("fallback");
    this.revoke("fallback");
  }

  private closePort(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.worker) {
      if (this.generation) {
        try {
          this.worker.port.postMessage({
            type: "DETACH",
            protocolVersion: PROTOCOL_VERSION,
            runtimeGeneration: this.generation,
            portId: this.portId,
            accountEpoch: this.epoch,
            requestId: String(++this.nextId),
          });
        } catch {
          /* The lease still reclaims an unreachable port. */
        }
      }
      this.worker.onerror = null;
      this.worker.port.onmessage = null;
      this.worker.port.onmessageerror = null;
      this.worker.port.close();
      this.worker = undefined;
    }
    for (const id of this.pending.keys())
      this.settle(
        id,
        new RuntimeError("session-reset", "Runtime connection retired"),
        true,
      );
    this.generation = this.portId = "";
  }

  private suspend = (): void => {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    this.closePort();
    this.revoke("resume");
  };

  private resume = (): void => {
    if (!this.suspended || this.disposed) return;
    this.suspended = false;
    if (this.mode === "fallback") {
      void this.bootstrap().catch(() => {});
      return;
    }
    this.connecting = undefined;
    void this.connect()
      .then(() => this.bootstrap())
      .catch(() => this.fail());
  };

  private visibility = (): void => {
    if (this.disposed || this.suspended) return;
    if (this.mode !== "worker") return;
    if (this.visible && Date.now() - this.lastLease >= PORT_LEASE_MS) {
      this.revoke("resume");
      void this.connect()
        .then(() => this.bootstrap())
        .catch(() => this.fail());
      return;
    }
    void this.request(
      "VISIBILITY",
      { visible: this.visible, online: this.online, marker: this.readMarker() },
      "ack",
      false,
    )
      .then(() => {
        if (this.visible && this.online) {
          this.lastLease = Date.now();
          this.revoke("resume");
          return this.bootstrap();
        }
      })
      .catch(() => this.fail());
  };

  dispose(): void {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
    this.events?.removeEventListener("pagehide", this.suspend);
    this.events?.removeEventListener("freeze", this.suspend);
    this.events?.removeEventListener("pageshow", this.resume);
    this.events?.removeEventListener("resume", this.resume);
    this.events?.removeEventListener("online", this.visibility);
    this.events?.removeEventListener("offline", this.visibility);
    this.document?.removeEventListener("visibilitychange", this.visibility);
    this.releaseAuth();
    this.auth.dispose();
    this.subscriptions.clear();
    this.frameListeners.clear();
    this.resetListeners.clear();
    this.modeListeners.clear();
  }
}

export function createRuntimeBridge(
  options: RuntimeBridgeOptions = {},
): RuntimeBridge {
  return new PageRuntimeBridge(options);
}
