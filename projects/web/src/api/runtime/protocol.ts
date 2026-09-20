import type { ClientErrorEnvelope } from "@todou/shared";
import { defineProjection, type ProjectionDescriptor } from "./projections.ts";
import {
  canonical,
  type InvalidationTarget,
  type ResourceDescriptor,
  validApiPath,
  validateResource,
} from "./resources.ts";

export const PROTOCOL_VERSION = 1 as const;
export type ErrorEnvelope = ClientErrorEnvelope;
export interface RuntimeSnapshot {
  projectionHash: string;
  status: "pending" | "success" | "error";
  fetchStatus: "idle" | "fetching" | "paused";
  data?: unknown;
  error?: ErrorEnvelope;
  fetchedAt: number;
  stale: boolean;
  revision: number;
  generation: number;
  dropData?: boolean;
}
export interface ReadOptions {
  signal?: AbortSignal;
  forceFresh?: boolean;
  requiredGeneration?: number;
  freshnessMs?: number;
}
export interface InvalidateOptions {
  operationId?: string;
  eventSeq?: number;
  refetchType?: "none" | "active" | "inactive" | "all";
  selection?: string[];
  completion?: "dirty-applied" | "reads-settled";
  throwOnError?: boolean;
  cancelRefetch?: boolean;
  onApplied?: (generationByTarget: Record<string, number>) => void;
}
export interface ProtocolEnvelope {
  protocolVersion: 1;
  runtimeGeneration: string;
  portId: string;
  requestId: string;
  accountEpoch: number;
}
export interface ControlPayload {
  operationId: string;
  targets: InvalidationTarget[];
  selection?: string[];
  completion?: "dirty-applied" | "reads-settled";
  throwOnError?: boolean;
  cancelRefetch?: boolean;
  refetchType?: "none" | "active" | "inactive" | "all";
  source?: string;
  eventSeq?: number;
}
export type ClientMessage =
  | {
      type: "HELLO";
      protocolVersion: 1;
      requestId: string;
      buildId: string;
      apiMount: string;
      pageOrigin: string;
      clientOrigin: string;
    }
  | (ProtocolEnvelope &
      (
        | { type: "AUTH_BOOTSTRAP"; marker?: unknown }
        | {
            type: "SUBSCRIBE";
            subscriptionId: string;
            projection: ProjectionDescriptor;
            enabled: boolean;
            visible: boolean;
            freshnessMs?: number;
            policy?: unknown;
          }
        | { type: "UNSUBSCRIBE"; subscriptionId: string }
        | ({
            type: "READ_FRESH";
            forceFresh?: boolean;
            requiredGeneration?: number;
            freshnessMs?: number;
            reason?: string;
          } & (
            | { resource: ResourceDescriptor; projection?: never }
            | { projection: ProjectionDescriptor; resource?: never }
          ))
        | ({ type: "REFRESH" | "INVALIDATE" } & ControlPayload)
        | {
            type: "VISIBILITY";
            visible: boolean;
            online: boolean;
            marker?: unknown;
          }
        | {
            type: "CANCEL";
            targetRequestIds?: string[];
            projectionIds?: string[];
            suspendMirror?: boolean;
          }
        | { type: "SESSION_RESET"; reason: string; expectedEpoch: number }
        | { type: "PING"; nonce: string }
        | { type: "DETACH" }
        | {
            type: "RESUME";
            projectionIds: string[];
            operationId?: string;
            requiredGeneration?: number;
          }
        | {
            type: "AUTH_TRANSITION";
            transitionId: string;
            phase: "begin" | "end" | "failed";
            expectedEpoch: number;
            marker?: unknown;
          }
      ));
export type ServerMessage = ProtocolEnvelope &
  (
    | { type: "READY"; mode: "worker" }
    | { type: "ACK"; generationByTarget?: Record<string, number> }
    | { type: "IDENTITY"; me: unknown }
    | { type: "SNAPSHOT"; subscriptionId: string; snapshot: RuntimeSnapshot }
    | { type: "RESULT"; data?: unknown; generation?: number }
    | { type: "ERROR"; error: ErrorEnvelope; subscriptionId?: string }
    | {
        type: "INVALIDATED";
        targets: InvalidationTarget[];
        runtimeEventSeq?: number;
        generationByTarget?: Record<string, number>;
      }
    | {
        type: "FRAME";
        runtimeEventSeq: number;
        origin?: string;
        invalidations: unknown[];
        event?: unknown;
        eventType?: "change" | "me" | "reconnect";
      }
    | { type: "CANONICAL_SLUG"; requested: string; canonical: string }
    | { type: "SESSION_RESET"; reason: string }
    | { type: "PONG"; nonce: string }
  );
export type RuntimeRequest = ClientMessage;
export type RuntimeResponse = ServerMessage;

export class RuntimeError extends Error {
  readonly kind: "cancelled" | "timeout" | "protocol" | "session-reset";
  constructor(
    kind: "cancelled" | "timeout" | "protocol" | "session-reset",
    message: string,
  ) {
    super(message);
    this.kind = kind;
    this.name =
      kind === "cancelled"
        ? "AbortError"
        : kind === "timeout"
          ? "TimeoutError"
          : "RuntimeError";
  }
}

export function validateTargets(
  value: unknown,
): asserts value is InvalidationTarget[] {
  if (!Array.isArray(value) || value.length > 5000)
    throw new RuntimeError("protocol", "Invalid invalidation targets");
  for (const target of value) {
    if (!target || typeof target !== "object")
      throw new RuntimeError("protocol", "Invalid invalidation target");
    switch (target.type) {
      case "user":
        break;
      case "project":
        if (
          typeof target.slug !== "string" &&
          typeof target.id !== "string" &&
          typeof target.id !== "number"
        )
          throw new RuntimeError("protocol", "Missing project scope");
        break;
      case "issue":
        if (
          typeof target.slug !== "string" ||
          !Number.isSafeInteger(target.number) ||
          target.number < 1
        )
          throw new RuntimeError("protocol", "Invalid issue scope");
        break;
      case "read":
        if (
          (target.slug !== undefined && typeof target.slug !== "string") ||
          (target.number !== undefined &&
            (!Number.isSafeInteger(target.number) ||
              target.number < 1 ||
              typeof target.slug !== "string"))
        )
          throw new RuntimeError("protocol", "Invalid read scope");
        break;
      case "projection":
        if (typeof target.projectionHash !== "string")
          throw new RuntimeError("protocol", "Invalid projection target");
        break;
      case "key-prefix":
        if (!Array.isArray(target.queryKey))
          throw new RuntimeError("protocol", "Invalid query prefix");
        break;
      case "resource":
        validateResource(target.resource);
        break;
      default:
        throw new RuntimeError("protocol", "Unknown invalidation scope");
    }
  }
}

/** Shape validation only: the host must additionally bind the real port/epoch. */
export function validateClientMessage(
  value: unknown,
): asserts value is ClientMessage {
  if (
    !value ||
    typeof value !== "object" ||
    canonical(value).length > 1_048_576
  )
    throw new RuntimeError("protocol", "Invalid message");
  const message = value as Record<string, unknown>;
  const identifier = (id: unknown) =>
    typeof id === "string" && id.length > 0 && id.length <= 262_144;
  const strings = (ids: unknown) =>
    Array.isArray(ids) && ids.length <= 5000 && ids.every(identifier);
  if (
    message.protocolVersion !== PROTOCOL_VERSION ||
    !identifier(message.requestId)
  )
    throw new RuntimeError("protocol", "Unsupported protocol or request ID");
  if (message.type === "HELLO") {
    if (
      !validApiPath(message.apiMount) ||
      !identifier(message.buildId) ||
      !identifier(message.pageOrigin) ||
      !identifier(message.clientOrigin)
    )
      throw new RuntimeError("protocol", "Invalid hello");
    return;
  }
  if (
    !identifier(message.runtimeGeneration) ||
    !identifier(message.portId) ||
    !Number.isSafeInteger(message.accountEpoch) ||
    (message.accountEpoch as number) < 0
  )
    throw new RuntimeError("protocol", "Invalid message envelope");
  if (
    message.requiredGeneration !== undefined &&
    (!Number.isSafeInteger(message.requiredGeneration) ||
      (message.requiredGeneration as number) < 0)
  )
    throw new RuntimeError("protocol", "Invalid resource generation");
  if (
    message.freshnessMs !== undefined &&
    (typeof message.freshnessMs !== "number" ||
      !Number.isFinite(message.freshnessMs) ||
      message.freshnessMs < 0)
  ) {
    throw new RuntimeError("protocol", "Invalid freshness window");
  }
  switch (message.type) {
    case "AUTH_BOOTSTRAP":
    case "DETACH":
      return;
    case "SUBSCRIBE":
      if (
        !identifier(message.subscriptionId) ||
        typeof message.enabled !== "boolean" ||
        typeof message.visible !== "boolean"
      )
        break;
      defineProjection(message.projection as ProjectionDescriptor);
      return;
    case "UNSUBSCRIBE":
      if (identifier(message.subscriptionId)) return;
      break;
    case "READ_FRESH":
      if (
        (message.resource === undefined) ===
        (message.projection === undefined)
      )
        break;
      if (message.resource !== undefined) validateResource(message.resource);
      else defineProjection(message.projection as ProjectionDescriptor);
      if (
        message.forceFresh === undefined ||
        typeof message.forceFresh === "boolean"
      )
        return;
      break;
    case "REFRESH":
    case "INVALIDATE":
      validateTargets(message.targets);
      if (
        !identifier(message.operationId) ||
        (message.selection !== undefined && !strings(message.selection)) ||
        (message.refetchType !== undefined &&
          !["none", "active", "inactive", "all"].includes(
            String(message.refetchType),
          )) ||
        (message.completion !== undefined &&
          !["dirty-applied", "reads-settled"].includes(
            String(message.completion),
          )) ||
        (message.throwOnError !== undefined &&
          typeof message.throwOnError !== "boolean") ||
        (message.cancelRefetch !== undefined &&
          typeof message.cancelRefetch !== "boolean")
      )
        break;
      return;
    case "VISIBILITY":
      if (
        typeof message.visible === "boolean" &&
        typeof message.online === "boolean"
      )
        return;
      break;
    case "CANCEL":
      if (
        (message.targetRequestIds === undefined ||
          strings(message.targetRequestIds)) &&
        (message.projectionIds === undefined ||
          strings(message.projectionIds)) &&
        (message.suspendMirror === undefined ||
          typeof message.suspendMirror === "boolean")
      )
        return;
      break;
    case "SESSION_RESET":
      if (
        typeof message.reason === "string" &&
        Number.isSafeInteger(message.expectedEpoch)
      )
        return;
      break;
    case "PING":
      if (identifier(message.nonce)) return;
      break;
    case "RESUME":
      if (strings(message.projectionIds)) return;
      break;
    case "AUTH_TRANSITION":
      if (
        identifier(message.transitionId) &&
        ["begin", "end", "failed"].includes(String(message.phase)) &&
        Number.isSafeInteger(message.expectedEpoch)
      )
        return;
      break;
  }
  throw new RuntimeError("protocol", "Unknown or malformed message");
}
export function parseClientMessage(value: unknown): ClientMessage {
  validateClientMessage(value);
  return value;
}
