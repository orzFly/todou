import { type Me, serializeClientError } from "@todou/shared";
import {
  type AuthMarker,
  markerToken,
  parseAuthMarker,
  runtimeId,
} from "./auth-control.ts";
import { type ProjectionDescriptor, projectionId } from "./projections.ts";
import {
  type ClientMessage,
  PROTOCOL_VERSION,
  parseClientMessage,
  RuntimeError,
  type RuntimeSnapshot,
  type ServerMessage,
} from "./protocol.ts";
import type { ResourceRuntime } from "./runtime.ts";

export const VISIBLE_PROBE_MS = 15_000;
export const PORT_LEASE_MS = 90_000;
export const HANDSHAKE_MS = 2_000;

export interface RuntimePort {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export type RuntimeFrame = {
  runtimeEventSeq: number;
  origin?: string;
  invalidations: unknown[];
  event?: unknown;
  eventType?: "change" | "me" | "reconnect";
};

type Subscription = {
  projection: ProjectionDescriptor;
  enabled: boolean;
  visible: boolean;
  freshnessMs?: number;
  paused: boolean;
  requiredGeneration: number;
  release?: () => void;
};
type PortState = {
  port: RuntimePort;
  id: string;
  origin: string;
  hello: boolean;
  authorizedEpoch: number | null;
  visible: boolean;
  online: boolean;
  lease: number;
  highestRequest: number;
  pending: Map<string, AbortController>;
  paths: Map<string, string[]>;
  subscriptions: Map<string, Subscription>;
};

/** Online identity is only in-flight shared. No completed /me cache is a gate. */
export class SessionIdentity {
  epoch = 0;
  accountId: string | null = null;
  marker: AuthMarker | null = null;
  private fenceVersion = 0;
  private readonly ended = new Set<string>();
  private flight?: {
    token: string;
    version: number;
    controller: AbortController;
    promise: Promise<Me>;
  };
  private readonly options: {
    online: (signal: AbortSignal) => Promise<Me>;
    onReset: (epoch: number, reason: string) => void;
  };
  constructor(options: {
    online: (signal: AbortSignal) => Promise<Me>;
    onReset: (epoch: number, reason: string) => void;
  }) {
    this.options = options;
  }

  get pending(): boolean {
    return !!this.flight;
  }
  get changing(): boolean {
    return this.marker?.phase === "begin";
  }
  async waitForValidation(): Promise<void> {
    await this.flight?.promise;
  }

  observeMarker(marker: AuthMarker | null): void {
    if (markerToken(marker) === markerToken(this.marker)) return;
    if (!marker && this.marker) return;
    if (marker?.phase === "begin" && this.ended.has(marker.transitionId))
      return;
    if (marker && marker.phase !== "begin") {
      this.ended.add(marker.transitionId);
      if (this.ended.size > 128)
        this.ended.delete(this.ended.values().next().value!);
    }
    // Messages can arrive in a different order on different ports. Only the
    // matching transition can end the current BEGIN.
    if (
      marker &&
      marker.phase !== "begin" &&
      this.marker?.phase === "begin" &&
      this.marker.transitionId !== marker.transitionId
    )
      return;
    this.marker = marker;
    this.revoke(marker?.phase === "begin" ? "auth-transition" : "auth-settled");
  }

  revoke(reason: string, expectedEpoch?: number): void {
    if (expectedEpoch !== undefined && expectedEpoch !== this.epoch) return;
    this.fenceVersion++;
    this.flight?.controller.abort();
    this.flight = undefined;
    this.accountId = null;
    this.epoch++;
    this.options.onReset(this.epoch, reason);
  }

  async bootstrap(marker: AuthMarker | null): Promise<Me> {
    this.observeMarker(marker);
    if (this.changing || markerToken(marker) !== markerToken(this.marker)) {
      throw new RuntimeError(
        "session-reset",
        "Authentication transition is in progress",
      );
    }
    const token = markerToken(this.marker);
    const version = this.fenceVersion;
    if (this.flight?.token === token && this.flight.version === version)
      return this.flight.promise;
    const controller = new AbortController();
    const flight = {
      token,
      version,
      controller,
      promise: Promise.resolve(undefined as unknown as Me),
    };
    const promise = Promise.resolve()
      .then(() => this.options.online(controller.signal))
      .then((me) => {
        if (
          controller.signal.aborted ||
          version !== this.fenceVersion ||
          token !== markerToken(this.marker) ||
          this.changing
        ) {
          throw new RuntimeError(
            "session-reset",
            "Discarded an obsolete identity response",
          );
        }
        const accountId = String(me.id);
        if (this.accountId !== null && this.accountId !== accountId) {
          // Retire private work before publishing the new identity. This /me was
          // itself online under the current settled marker and remains valid.
          this.accountId = null;
          this.epoch++;
          this.options.onReset(this.epoch, "identity-changed");
        }
        this.accountId = accountId;
        return me;
      })
      .catch((error: unknown) => {
        if (
          version === this.fenceVersion &&
          (error as { status?: number })?.status === 401 &&
          this.accountId !== null
        ) {
          this.revoke("unauthorized");
        }
        throw error;
      })
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      });
    flight.promise = promise;
    this.flight = flight;
    return promise;
  }

  dispose(): void {
    this.flight?.controller.abort();
    this.flight = undefined;
    this.fenceVersion++;
    this.accountId = null;
  }
}

export interface SessionHostOptions {
  runtime: ResourceRuntime;
  onlineIdentity: (signal: AbortSignal) => Promise<Me>;
  apiMount: string;
  pageOrigin: string;
  buildId?: string;
  generation?: string;
  now?: () => number;
  onDemand?: (demand: {
    connected: boolean;
    visible: boolean;
    epoch: number;
  }) => void;
}

/** Actual MessagePort bindings, never a caller-supplied portId, own authority. */
export class RuntimeSessionHost {
  readonly generation: string;
  readonly identity: SessionIdentity;
  private readonly ports = new Map<RuntimePort, PortState>();
  private readonly now: () => number;
  private readonly leaseTimer: ReturnType<typeof globalThis.setInterval>;
  private disposed = false;
  private readonly options: SessionHostOptions;
  constructor(options: SessionHostOptions) {
    this.options = options;
    this.generation = options.generation ?? runtimeId();
    this.now = options.now ?? Date.now;
    this.identity = new SessionIdentity({
      online: options.onlineIdentity,
      onReset: (epoch, reason) => this.resetPorts(epoch, reason),
    });
    this.leaseTimer = globalThis.setInterval(
      () => this.sweep(),
      VISIBLE_PROBE_MS,
    );
  }

  attach(port: RuntimePort): void {
    if (this.disposed) {
      port.close();
      return;
    }
    const state: PortState = {
      port,
      id: runtimeId(),
      origin: "",
      hello: false,
      authorizedEpoch: null,
      visible: false,
      online: true,
      lease: this.now() + PORT_LEASE_MS,
      highestRequest: -1,
      pending: new Map(),
      paths: new Map(),
      subscriptions: new Map(),
    };
    this.ports.set(port, state);
    port.onmessage = (event) => {
      void this.receive(state, event.data);
    };
    port.onmessageerror = () => this.detach(state);
    port.start();
  }

  get hasVisibleDemand(): boolean {
    return [...this.ports.values()].some(
      (state) => this.authorized(state) && state.visible && state.online,
    );
  }
  get portCount(): number {
    return this.ports.size;
  }

  sweep(): void {
    for (const state of this.ports.values())
      if (state.lease <= this.now()) this.detach(state);
  }

  frame(frame: RuntimeFrame): void {
    // Shared invalidation happens in RuntimeWatch first, including an origin's
    // own writes. Only the redundant page UI echo is filtered here.
    for (const state of this.ports.values()) {
      if (
        !this.authorized(state) ||
        this.identity.pending ||
        frame.origin === state.origin
      )
        continue;
      this.send(state, "event", { type: "FRAME", ...frame });
    }
  }

  canonicalSlug(requested: string, canonical: string): void {
    for (const state of this.ports.values()) {
      if (!this.authorized(state) || this.identity.pending) continue;
      for (const [requestId, paths] of state.paths) {
        if (
          paths.some(
            (path) =>
              path.split("/")[1] === "projects" &&
              decodeURIComponent(path.split("/")[2] ?? "") === requested,
          )
        ) {
          this.send(state, requestId, {
            type: "CANONICAL_SLUG",
            requested,
            canonical,
          });
        }
      }
    }
  }

  unauthorized(): void {
    if (this.identity.accountId !== null) this.identity.revoke("unauthorized");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.leaseTimer);
    this.identity.dispose();
    for (const state of this.ports.values()) this.detach(state);
    this.options.runtime.dispose();
  }

  private authorized(state: PortState): boolean {
    return (
      state.hello &&
      state.authorizedEpoch === this.identity.epoch &&
      this.identity.accountId !== null &&
      !this.identity.changing &&
      this.ports.has(state.port)
    );
  }

  private updateDemand(): void {
    this.options.onDemand?.({
      connected: [...this.ports.values()].some(
        (state) => this.authorized(state) && state.online,
      ),
      visible: this.hasVisibleDemand,
      epoch: this.identity.epoch,
    });
  }

  private resetPorts(epoch: number, reason: string): void {
    // Revoke port eligibility before clear/abort callbacks can publish anything.
    for (const state of this.ports.values()) {
      state.authorizedEpoch = null;
      for (const controller of state.pending.values()) controller.abort();
      for (const subscription of state.subscriptions.values()) {
        subscription.release?.();
        subscription.release = undefined;
      }
      // The page bridge replays only subscriptions still mounted after online
      // bootstrap. Retaining these would resurrect observers removed while
      // the port was unauthorized and unable to send UNSUBSCRIBE.
      state.subscriptions.clear();
    }
    this.options.runtime.setEpoch(epoch);
    for (const state of this.ports.values())
      if (state.hello)
        this.send(state, "event", { type: "SESSION_RESET", reason });
    this.updateDemand();
  }

  private detach(state: PortState): void {
    if (!this.ports.delete(state.port)) return;
    state.authorizedEpoch = null;
    for (const controller of state.pending.values()) controller.abort();
    for (const subscription of state.subscriptions.values())
      subscription.release?.();
    state.subscriptions.clear();
    state.port.onmessage = null;
    state.port.onmessageerror = null;
    state.port.close();
    this.updateDemand();
  }

  private send(
    state: PortState,
    requestId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!this.ports.has(state.port)) return;
    try {
      state.port.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        runtimeGeneration: this.generation,
        portId: state.id,
        requestId,
        accountEpoch: this.identity.epoch,
        ...payload,
      });
    } catch {
      this.detach(state);
    }
  }

  private bind(state: PortState, id: string, subscription: Subscription): void {
    subscription.release?.();
    subscription.release = undefined;
    if (!this.authorized(state)) return;
    subscription.release = this.options.runtime.subscribe(
      `${state.id}:${id}`,
      subscription.projection,
      {
        enabled: subscription.enabled,
        visible: state.visible && state.online && subscription.visible,
        freshnessMs: subscription.freshnessMs,
      },
      (snapshot: RuntimeSnapshot) => {
        if (
          !this.authorized(state) ||
          this.identity.pending ||
          subscription.paused ||
          state.subscriptions.get(id) !== subscription ||
          snapshot.generation < subscription.requiredGeneration
        )
          return;
        this.send(state, "event", {
          type: "SNAPSHOT",
          subscriptionId: id,
          snapshot,
        });
      },
    );
  }

  private marker(value: unknown): AuthMarker | null {
    if (value === undefined || value === null) return null;
    const marker = parseAuthMarker(value);
    if (!marker)
      throw new RuntimeError("protocol", "Malformed auth-control marker");
    return marker;
  }

  private async receive(state: PortState, value: unknown): Promise<void> {
    if (!this.ports.has(state.port)) return;
    let message: ClientMessage;
    let requestId = "invalid";
    let controller: AbortController | undefined;
    try {
      message = parseClientMessage(value);
      requestId = message.requestId;
      // Decimal increasing IDs bound retained memory and reject reuse even
      // after settlement. Each port starts its own sequence.
      const sequence = Number(requestId);
      if (
        !/^\d+$/.test(requestId) ||
        !Number.isSafeInteger(sequence) ||
        sequence <= state.highestRequest
      ) {
        throw new RuntimeError(
          "protocol",
          "Request IDs must increase on their real port",
        );
      }
      if (message.type === "HELLO") {
        if (
          state.hello ||
          message.pageOrigin !== this.options.pageOrigin ||
          message.apiMount !== this.options.apiMount ||
          (this.options.buildId !== undefined &&
            message.buildId !== this.options.buildId)
        ) {
          throw new RuntimeError(
            "protocol",
            "Incompatible worker origin, mount, or build",
          );
        }
        state.highestRequest = sequence;
        state.hello = true;
        state.origin = message.clientOrigin;
        this.send(state, requestId, { type: "READY", mode: "worker" });
        return;
      }
      if (
        !state.hello ||
        message.portId !== state.id ||
        message.runtimeGeneration !== this.generation
      ) {
        throw new RuntimeError(
          "protocol",
          "Port or runtime generation mismatch",
        );
      }
      state.highestRequest = sequence;
      const control = [
        "AUTH_BOOTSTRAP",
        "AUTH_TRANSITION",
        "SESSION_RESET",
        "DETACH",
        "PING",
        "VISIBILITY",
      ].includes(message.type);
      if (
        !control &&
        (!this.authorized(state) ||
          message.accountEpoch !== this.identity.epoch)
      ) {
        throw new RuntimeError(
          "session-reset",
          "Online identity confirmation is required",
        );
      }
      const resources =
        message.type === "READ_FRESH"
          ? message.resource
            ? [message.resource]
            : message.projection.resources
          : message.type === "SUBSCRIBE"
            ? message.projection.resources
            : [];
      if (
        resources.some(
          (resource) => resource.apiMount !== this.options.apiMount,
        )
      )
        throw new RuntimeError("protocol", "Resource API mount mismatch");
      if (resources.length)
        state.paths.set(
          requestId,
          resources.map((resource) => resource.path),
        );
      controller = new AbortController();
      state.pending.set(requestId, controller);
      const epoch = this.identity.epoch;
      const ack = (extra: Record<string, unknown> = {}) =>
        this.send(state, requestId, { type: "ACK", ...extra });
      const alive = () =>
        !controller!.signal.aborted &&
        this.authorized(state) &&
        epoch === this.identity.epoch;
      switch (message.type) {
        case "AUTH_BOOTSTRAP": {
          // Every bootstrap reconciles this page's desired observers, including
          // same-epoch visibility restores. The page replays its current set.
          state.authorizedEpoch = null;
          for (const subscription of state.subscriptions.values())
            subscription.release?.();
          state.subscriptions.clear();
          const me = await this.identity.bootstrap(this.marker(message.marker));
          if (!this.ports.has(state.port)) return;
          state.authorizedEpoch = this.identity.epoch;
          state.lease = this.now() + PORT_LEASE_MS;
          this.options.runtime.setEpoch(this.identity.epoch, String(me.id));
          this.send(state, requestId, { type: "IDENTITY", me });
          for (const peer of this.ports.values()) {
            for (const [id, subscription] of peer.subscriptions)
              this.bind(peer, id, subscription);
          }
          this.updateDemand();
          break;
        }
        case "AUTH_TRANSITION": {
          const marker = this.marker(
            message.marker ?? {
              transitionId: message.transitionId,
              phase: message.phase,
            },
          );
          if (
            !marker ||
            marker.transitionId !== message.transitionId ||
            marker.phase !== message.phase
          )
            throw new RuntimeError(
              "protocol",
              "Auth transition marker mismatch",
            );
          if (
            marker.phase === "begin" &&
            markerToken(marker) !== markerToken(this.identity.marker) &&
            message.expectedEpoch !== this.identity.epoch
          ) {
            throw new RuntimeError(
              "session-reset",
              "Authentication transition belongs to an obsolete epoch",
            );
          }
          if (
            marker.phase !== "begin" &&
            marker.transitionId !== this.identity.marker?.transitionId
          ) {
            // A late completion cannot change a newer settled marker either.
            // A page that missed BEGIN reports its durable marker through
            // AUTH_BOOTSTRAP, which must still perform online confirmation.
            ack();
            break;
          }
          this.identity.observeMarker(marker);
          ack();
          break;
        }
        case "SUBSCRIBE": {
          const previous = state.subscriptions.get(message.subscriptionId);
          previous?.release?.();
          const subscription: Subscription = {
            projection: message.projection,
            enabled: message.enabled,
            visible: message.visible,
            freshnessMs: message.freshnessMs,
            paused: false,
            requiredGeneration: 0,
          };
          state.subscriptions.set(message.subscriptionId, subscription);
          ack();
          this.bind(state, message.subscriptionId, subscription);
          break;
        }
        case "UNSUBSCRIBE":
          state.subscriptions.get(message.subscriptionId)?.release?.();
          state.subscriptions.delete(message.subscriptionId);
          ack();
          break;
        case "READ_FRESH": {
          const readOptions = {
            signal: controller.signal,
            forceFresh: message.forceFresh,
            requiredGeneration: message.requiredGeneration,
            freshnessMs: message.freshnessMs,
          };
          const data = message.resource
            ? await this.options.runtime.read(message.resource, readOptions)
            : await this.options.runtime.readProjection(
                message.projection!,
                readOptions,
              );
          await this.identity.waitForValidation();
          if (alive()) this.send(state, requestId, { type: "RESULT", data });
          break;
        }
        case "REFRESH":
        case "INVALIDATE": {
          let generationByTarget: Record<string, number> = {};
          const { targets, eventSeq } = message;
          await this.options.runtime.invalidate(message.targets, {
            ...message,
            refetchType: message.refetchType ?? "active",
            onApplied: (generations) => {
              generationByTarget = generations;
              ack({ generationByTarget });
              for (const peer of this.ports.values())
                if (this.authorized(peer))
                  this.send(peer, "event", {
                    type: "INVALIDATED",
                    targets,
                    generationByTarget,
                    runtimeEventSeq: eventSeq,
                  });
            },
          });
          if (
            alive() &&
            message.completion !== "dirty-applied" &&
            message.refetchType !== "none"
          )
            this.send(state, requestId, {
              type: "RESULT",
              data: { generationByTarget },
            });
          break;
        }
        case "VISIBILITY":
          this.identity.observeMarker(this.marker(message.marker));
          // A hidden→visible port must bootstrap before regaining visible demand.
          if (message.visible && !state.visible) state.authorizedEpoch = null;
          state.visible = message.visible;
          state.online = message.online;
          if (state.visible) state.lease = this.now() + PORT_LEASE_MS;
          for (const [id, subscription] of state.subscriptions)
            this.bind(state, id, subscription);
          ack();
          this.updateDemand();
          break;
        case "PING":
          if (state.visible) state.lease = this.now() + PORT_LEASE_MS;
          this.send(state, requestId, { type: "PONG", nonce: message.nonce });
          break;
        case "CANCEL":
          for (const id of message.targetRequestIds ?? [])
            state.pending.get(id)?.abort();
          if (message.suspendMirror)
            for (const subscription of state.subscriptions.values()) {
              if (
                message.projectionIds?.includes(
                  projectionId(subscription.projection),
                ) ||
                message.projectionIds?.includes(
                  subscription.projection.queryHash,
                )
              )
                subscription.paused = true;
            }
          ack();
          break;
        case "RESUME":
          for (const [id, subscription] of state.subscriptions)
            if (
              message.projectionIds.includes(
                projectionId(subscription.projection),
              ) ||
              message.projectionIds.includes(subscription.projection.queryHash)
            ) {
              subscription.paused = false;
              subscription.requiredGeneration = Math.max(
                subscription.requiredGeneration,
                message.requiredGeneration ?? 0,
              );
              this.bind(state, id, subscription);
            }
          ack();
          break;
        case "SESSION_RESET":
          this.identity.revoke(message.reason, message.expectedEpoch);
          ack();
          break;
        case "DETACH":
          ack();
          this.detach(state);
          break;
      }
    } catch (error) {
      if ((error as { status?: number })?.status === 401) this.unauthorized();
      this.send(state, requestId, {
        type: "ERROR",
        error: serializeClientError(error),
      });
    } finally {
      state.paths.delete(requestId);
      if (controller && state.pending.get(requestId) === controller)
        state.pending.delete(requestId);
    }
  }
}
