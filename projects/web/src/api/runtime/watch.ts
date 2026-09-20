import {
  CrossChangeEvent,
  MeEvent,
  SSE_CHANGE_EVENT,
  SSE_ME_EVENT,
  SSE_PING_EVENT,
  SseDecoder,
} from "@todou/shared";
import {
  cachedIssueRow,
  coalesceBatch,
  entryWantsRefetch,
  INVALIDATE_COALESCE_MS,
  type Invalidation,
  inboxAttentionDiffers,
  inboxInvalidations,
  inboxRowContentDiffers,
  invalidationsFor,
  meInvalidations,
  metadataEntryDiffers,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  reconnectInvalidations,
  STALL_TIMEOUT_MS,
  statusCategories,
} from "../event-rules.ts";
import { issueListDescriptorOf } from "../issues-cache.ts";
import { canonical, type InvalidationTarget } from "./resources.ts";
import type { ResourceRuntime } from "./runtime.ts";
import type { RuntimeFrame } from "./session.ts";

export interface RuntimeWatchOptions {
  runtime: ResourceRuntime;
  url: string;
  fetch?: typeof fetch;
  random?: () => number;
  onFrame: (frame: RuntimeFrame) => void;
  onUnauthorized?: () => void;
}

/** Translate the page rules over the runtime's server-owned cache view. */
export function watchTargets(
  runtime: ResourceRuntime,
  invalidations: Invalidation[],
): {
  dirty: InvalidationTarget[];
  refresh: InvalidationTarget[];
} {
  const dirty: InvalidationTarget[] = [];
  const refresh: InvalidationTarget[] = [];
  const cache = runtime.cacheView;
  const projections = runtime.getProjections();
  for (const { key, scope } of invalidations) {
    if (scope === "refetch") {
      const target: InvalidationTarget = { type: "key-prefix", queryKey: key };
      dirty.push(target);
      refresh.push(target);
      continue;
    }
    for (const projection of projections) {
      if (
        !key.every(
          (part, index) =>
            canonical(part) === canonical(projection.queryKey[index] ?? null),
        )
      )
        continue;
      const data = cache.getQueryData(projection.queryKey);
      let shouldDirty = false;
      let shouldRefresh = false;
      if ("inboxRows" in scope) {
        shouldRefresh = scope.inboxRows.some((v) =>
          inboxAttentionDiffers(data, v.project, v.number, v.row),
        );
        shouldDirty =
          shouldRefresh ||
          scope.inboxRows.some((v) =>
            inboxRowContentDiffers(data, v.project, v.number, v.row),
          );
      } else if ("metadataRows" in scope) {
        shouldDirty = shouldRefresh = scope.metadataRows.some((change) =>
          metadataEntryDiffers(data, change),
        );
      } else {
        const context = {
          cached: (number: number) => cachedIssueRow(cache, key, number),
          categoryOf: statusCategories(
            cache,
            typeof key[1] === "string" ? key[1] : "",
          ),
        };
        shouldDirty = shouldRefresh = scope.issueRows.some((verdict) =>
          entryWantsRefetch(
            verdict,
            issueListDescriptorOf(projection.meta),
            data,
            context,
          ),
        );
      }
      const target: InvalidationTarget = {
        type: "projection",
        projectionHash: projection.queryHash,
      };
      if (shouldDirty) dirty.push(target);
      if (shouldRefresh) refresh.push(target);
    }
  }
  return { dirty, refresh };
}

/** Fetch-based SSE reader: no DOM, no page API singleton, no EventSource. */
export class RuntimeWatch {
  private readonly fetcher: typeof fetch;
  private readonly random: () => number;
  private active = false;
  private visible = false;
  private epoch = -1;
  private controller?: AbortController;
  private reconnectTimer?: ReturnType<typeof globalThis.setTimeout>;
  private stallTimer?: ReturnType<typeof globalThis.setTimeout>;
  private flushTimer?: ReturnType<typeof globalThis.setTimeout>;
  private pending: Invalidation[] = [];
  private frames: Omit<RuntimeFrame, "runtimeEventSeq">[] = [];
  private delay = RECONNECT_BASE_MS;
  private sequence = 0;
  private connectedBefore = false;

  private readonly options: RuntimeWatchOptions;
  constructor(options: RuntimeWatchOptions) {
    this.options = options;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.random = options.random ?? Math.random;
  }

  setDemand(demand: {
    connected: boolean;
    visible: boolean;
    epoch: number;
  }): void {
    const changedEpoch = demand.epoch !== this.epoch;
    const becameVisible = !this.visible && demand.visible;
    this.visible = demand.visible;
    if (changedEpoch) {
      this.stop();
      this.epoch = demand.epoch;
      this.connectedBefore = false;
    }
    if (!demand.connected) {
      this.stop();
      return;
    }
    if (!this.active) {
      this.active = true;
      void this.connect();
    } else if (becameVisible && this.connectedBefore) this.compensate();
  }

  dispose(): void {
    this.stop();
  }

  /** Exposed for deterministic stream tests; production calls it on decoded frames. */
  accept(eventName: string, data: string): void {
    if (!this.active) return;
    if (eventName === "hello") {
      try {
        if (typeof JSON.parse(data) !== "object") return;
      } catch {
        return;
      }
      this.armStall();
      this.delay = RECONNECT_BASE_MS;
      if (this.connectedBefore) this.compensate();
      this.connectedBefore = true;
      return;
    }
    if (eventName === SSE_PING_EVENT) {
      this.armStall();
      return;
    }
    try {
      if (eventName === SSE_CHANGE_EVENT) {
        const event = CrossChangeEvent.parse(JSON.parse(data));
        this.armStall();
        const invalidations = [
          ...invalidationsFor(event, event.project),
          ...inboxInvalidations(event),
        ];
        this.enqueue(invalidations, {
          eventType: "change",
          event,
          invalidations,
        });
      } else if (eventName === SSE_ME_EVENT) {
        const event = MeEvent.parse(JSON.parse(data));
        this.armStall();
        const invalidations = meInvalidations(event);
        this.enqueue(invalidations, {
          eventType: "me",
          event,
          origin: event.origin,
          invalidations,
        });
      }
    } catch {
      /* Malformed frames cannot kill the other ports or refresh content. */
    }
  }

  private compensate(): void {
    const invalidations: Invalidation[] = reconnectInvalidations().map(
      (key) => ({ key, scope: "refetch" }),
    );
    this.enqueue(invalidations, { eventType: "reconnect", invalidations });
  }

  private enqueue(
    invalidations: Invalidation[],
    frame: Omit<RuntimeFrame, "runtimeEventSeq">,
  ): void {
    this.pending.push(...invalidations);
    this.frames.push(frame);
    if (this.flushTimer === undefined)
      this.flushTimer = globalThis.setTimeout(
        () => this.flush(),
        INVALIDATE_COALESCE_MS,
      );
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (!this.active) return;
    const invalidations = coalesceBatch(this.pending);
    const frames = this.frames;
    this.pending = [];
    this.frames = [];
    const { dirty, refresh } = watchTargets(
      this.options.runtime,
      invalidations,
    );
    // One dirty advancement, one selected visible refresh. Using invalidate
    // twice would advance generation twice and manufacture extra follow-ups.
    const selection = this.options.runtime
      .getProjections()
      .filter((projection) =>
        refresh.some((target) =>
          target.type === "projection"
            ? target.projectionHash === projection.queryHash
            : target.type === "key-prefix" &&
              target.queryKey.every(
                (part, index) =>
                  canonical(part) ===
                  canonical(projection.queryKey[index] ?? null),
              ),
        ),
      )
      .map((projection) => projection.queryHash);
    void this.options.runtime
      .invalidate(dirty, {
        refetchType: this.visible ? "active" : "none",
        selection,
        completion: "dirty-applied",
      })
      .catch(() => {});
    for (const frame of frames)
      this.options.onFrame({ ...frame, runtimeEventSeq: ++this.sequence });
  }

  private armStall(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = globalThis.setTimeout(
      () => this.reconnect(),
      STALL_TIMEOUT_MS,
    );
  }

  private async connect(): Promise<void> {
    if (!this.active) return;
    const controller = new AbortController();
    this.controller = controller;
    this.armStall();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(this.options.url, {
        credentials: "same-origin",
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (response.status === 401) {
        this.stop();
        this.options.onUnauthorized?.();
        return;
      }
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/event-stream") ||
        !response.body
      ) {
        throw new Error("Watch did not return an event stream");
      }
      reader = response.body.getReader();
      const text = new TextDecoder();
      const decoder = new SseDecoder();
      let unframedBytes = 0;
      while (
        this.active &&
        this.controller === controller &&
        !controller.signal.aborted
      ) {
        const chunk = await reader.read();
        if (chunk.done) break;
        unframedBytes += chunk.value.byteLength;
        const frames = decoder.push(text.decode(chunk.value, { stream: true }));
        if (frames.length) unframedBytes = 0;
        // Bound a malicious/incomplete never-terminated frame.
        if (unframedBytes > 1_048_576)
          throw new Error("Watch frame is too large");
        for (const frame of frames) this.accept(frame.event, frame.data);
      }
    } catch {
      /* The bounded reconnect loop owns transport failures. */
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (this.active && this.controller === controller) this.reconnect();
    }
  }

  private reconnect(): void {
    if (!this.active || this.reconnectTimer !== undefined) return;
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.stallTimer);
    // Jitter stays within the approved 1–30 second range.
    const delay = Math.min(
      RECONNECT_MAX_MS,
      Math.max(RECONNECT_BASE_MS, this.delay * (0.75 + this.random() * 0.5)),
    );
    this.delay = Math.min(RECONNECT_MAX_MS, this.delay * 2);
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private stop(): void {
    this.active = false;
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stallTimer);
    clearTimeout(this.flushTimer);
    this.reconnectTimer = this.stallTimer = this.flushTimer = undefined;
    this.pending = [];
    this.frames = [];
  }
}
