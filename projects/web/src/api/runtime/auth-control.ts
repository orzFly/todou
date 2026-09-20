export type AuthMarker = {
  transitionId: string;
  phase: "begin" | "end" | "failed";
};

export type AuthStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface AuthLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
export interface AuthChannel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}
export interface AuthControlOptions {
  apiMount: string;
  storage?: AuthStorage | null;
  locks?: AuthLocks | null;
  channel?: AuthChannel | null;
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  randomId?: () => string;
}

export function runtimeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

/** Stable across worker versions and fallback pages; contains no identity. */
export function authControlName(apiMount: string): string {
  return `todou:auth-control:v1:${apiMount.replace(/\/$/, "")}`;
}

export function parseAuthMarker(value: unknown): AuthMarker | null {
  if (!value || typeof value !== "object") return null;
  const marker = value as Partial<AuthMarker>;
  if (
    typeof marker.transitionId !== "string" ||
    !marker.transitionId ||
    marker.transitionId.length > 200 ||
    !["begin", "end", "failed"].includes(marker.phase ?? "")
  )
    return null;
  return {
    transitionId: marker.transitionId,
    phase: marker.phase as AuthMarker["phase"],
  };
}

export function markerToken(marker: AuthMarker | null): string {
  return marker ? `${marker.transitionId}:${marker.phase}` : "initial";
}

export class AuthFenceError extends Error {
  constructor(
    message = "Authentication changed; online confirmation is required",
  ) {
    super(message);
    this.name = "SessionResetError";
  }
}

/** localStorage is the delivery fence; the channel merely makes revocation fast. */
export class AuthControl {
  readonly name: string;
  private readonly capabilities: boolean;
  private readonly storage: AuthStorage | null;
  private readonly locks: AuthLocks | null;
  private readonly channel: AuthChannel | null;
  private readonly events?: AuthControlOptions["events"];
  private readonly randomId: () => string;
  private readonly listeners = new Set<(marker: AuthMarker | null) => void>();
  private current: string;
  private readonly ended = new Set<string>();
  private usable = true;
  private readonly storageListener = (event: Event) => {
    if (
      (event as StorageEvent).key === this.name ||
      (event as StorageEvent).key === null
    )
      this.notify();
  };

  constructor(options: AuthControlOptions) {
    this.name = authControlName(options.apiMount);
    this.storage = options.storage ?? null;
    this.locks = options.locks ?? null;
    this.channel = options.channel ?? null;
    this.events = options.events;
    this.randomId = options.randomId ?? runtimeId;
    let storageWorks = false;
    try {
      const key = `${this.name}:probe:${this.randomId()}`;
      this.storage?.setItem(key, "1");
      storageWorks = this.storage?.getItem(key) === "1";
      this.storage?.removeItem(key);
      this.current = markerToken(this.read());
    } catch {
      this.usable = false;
      this.current = "unavailable";
    }
    this.capabilities =
      storageWorks && typeof this.locks?.request === "function";
    if (this.channel)
      this.channel.onmessage = (event) => {
        const marker = parseAuthMarker(event.data);
        if (
          !marker ||
          (marker.phase === "begin" && this.ended.has(marker.transitionId))
        )
          return;
        if (marker.phase !== "begin") {
          this.ended.add(marker.transitionId);
          if (this.ended.size > 128)
            this.ended.delete(this.ended.values().next().value!);
        }
        let stored: AuthMarker | null;
        try {
          stored = this.read();
        } catch {
          stored = null;
        }
        if (markerToken(stored) === markerToken(marker)) this.notify();
        else if (marker.phase === "begin") {
          // A peer without working storage can only send a best-effort fence.
          // Consumers must disable sharing if this cannot be reconciled with
          // their durable marker; the hint never replaces localStorage.
          for (const listener of this.listeners) listener(marker);
        }
      };
    this.events?.addEventListener("storage", this.storageListener);
  }
  get supported(): boolean {
    return this.capabilities && this.usable;
  }
  get available(): boolean {
    return this.usable && this.storage !== null;
  }

  read(): AuthMarker | null {
    if (!this.usable || !this.storage)
      throw new AuthFenceError("Authentication control storage is unavailable");
    try {
      const raw = this.storage.getItem(this.name);
      if (raw === null) return null;
      const marker = parseAuthMarker(JSON.parse(raw));
      if (!marker) throw new Error("Invalid authentication control marker");
      return marker;
    } catch (error) {
      this.usable = false;
      throw error;
    }
  }

  capture(): string {
    const marker = this.read();
    if (marker?.phase === "begin") throw new AuthFenceError();
    return markerToken(marker);
  }

  assert(token: string): void {
    if (this.capture() !== token) {
      this.notify();
      throw new AuthFenceError();
    }
  }

  subscribe(listener: (marker: AuthMarker | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** An old END/FAILED must never settle another page's later BEGIN. */
  finish(transitionId: string, phase: "end" | "failed"): boolean {
    const current = this.read();
    if (current?.transitionId !== transitionId || current.phase !== "begin")
      return false;
    this.publish({ transitionId, phase });
    return true;
  }

  async transition<T>(
    action: () => Promise<T>,
    hooks: {
      fence: (marker: AuthMarker) => Promise<void>;
      confirm: () => Promise<void>;
      recover: () => Promise<void>;
    },
  ): Promise<T> {
    if (!this.supported) {
      // Fallback still revokes modern worker peers. Without storage the
      // channel is best effort; without locks no global serialization can be
      // promised, so this page never enables private shared caching.
      const marker: AuthMarker = {
        transitionId: this.randomId(),
        phase: "begin",
      };
      const run = async () => {
        if (this.available && this.read()?.phase === "begin")
          throw new AuthFenceError(
            "Another authentication transition is active",
          );
        this.publishFallback(marker);
        await hooks.fence(marker);
        try {
          const value = await action();
          const settled: AuthMarker = { ...marker, phase: "end" };
          this.publishFallback(settled);
          await hooks.fence(settled);
          await hooks.confirm();
          return value;
        } catch (error) {
          const failed: AuthMarker = { ...marker, phase: "failed" };
          this.publishFallback(failed);
          await hooks.fence(failed).catch(() => {});
          await hooks.confirm().catch(() => {});
          throw error;
        }
      };
      return this.locks ? this.locks.request(this.name, run) : run();
    }
    return this.locks!.request(this.name, async () => {
      const abandoned = this.read();
      if (abandoned?.phase === "begin") {
        // Acquiring the lock proves its previous owner has gone. Online
        // confirmation, never an elapsed-time guess, licenses recovery.
        await hooks.recover();
        if (!this.finish(abandoned.transitionId, "failed"))
          throw new AuthFenceError();
        await hooks.fence(this.read()!);
        await hooks.confirm();
      }
      const marker: AuthMarker = {
        transitionId: this.randomId(),
        phase: "begin",
      };
      this.publish(marker);
      let value: T;
      try {
        await hooks.fence(marker);
        value = await action();
      } catch (error) {
        if (this.finish(marker.transitionId, "failed")) {
          await hooks.fence(this.read()!).catch(() => {});
          await hooks.confirm().catch(() => {});
        }
        throw error;
      }
      if (!this.finish(marker.transitionId, "end")) throw new AuthFenceError();
      await hooks.fence(this.read()!);
      await hooks.confirm();
      return value;
    });
  }

  /** A removed marker is a revoked fence, never an initial identity again. */
  async restoreMarker(
    verify: () => Promise<void>,
    fence: (marker: AuthMarker) => Promise<void>,
  ): Promise<void> {
    if (!this.supported) return;
    await this.locks!.request(this.name, async () => {
      if (this.read() !== null) return;
      await verify();
      if (this.read() !== null) return;
      const marker: AuthMarker = {
        transitionId: this.randomId(),
        phase: "failed",
      };
      this.publish(marker);
      await fence(marker);
    });
  }

  /** Recover a crashed transition without starting an authentication HTTP action. */
  async recover(hooks: {
    verify: () => Promise<void>;
    fence: (marker: AuthMarker) => Promise<void>;
  }): Promise<void> {
    if (!this.supported) return;
    await this.locks!.request(this.name, async () => {
      const marker = this.read();
      if (marker?.phase !== "begin") return;
      await hooks.verify();
      if (this.finish(marker.transitionId, "failed"))
        await hooks.fence(this.read()!);
    });
  }

  dispose(): void {
    this.events?.removeEventListener("storage", this.storageListener);
    this.channel?.close();
    this.listeners.clear();
  }

  private publish(marker: AuthMarker): void {
    try {
      this.storage!.setItem(this.name, JSON.stringify(marker));
    } catch (error) {
      this.usable = false;
      for (const listener of this.listeners) listener(null);
      try {
        this.channel?.postMessage(marker);
      } catch {
        /* Best effort revocation. */
      }
      throw error;
    }
    this.notify();
    try {
      this.channel?.postMessage(marker);
    } catch {
      /* Storage remains authoritative. */
    }
  }

  private publishFallback(marker: AuthMarker): void {
    try {
      const current = this.storage?.getItem(this.name);
      const previous = current ? parseAuthMarker(JSON.parse(current)) : null;
      // Never let an unsupported page's old END replace someone else's BEGIN.
      if (
        marker.phase === "begin" ||
        previous?.transitionId === marker.transitionId
      ) {
        this.storage?.setItem(this.name, JSON.stringify(marker));
      }
    } catch {
      this.usable = false;
    }
    for (const listener of this.listeners) listener(marker);
    try {
      this.channel?.postMessage(marker);
    } catch {
      /* No shared mode on this page. */
    }
  }

  private notify(): void {
    let marker: AuthMarker | null;
    try {
      marker = this.read();
    } catch {
      this.current = "unavailable";
      for (const listener of this.listeners) listener(null);
      return;
    }
    const token = markerToken(marker);
    if (token === this.current) return;
    this.current = token;
    for (const listener of this.listeners) listener(marker);
  }
}

export function browserAuthControl(apiMount: string): AuthControl {
  let storage: AuthStorage | null = null;
  let locks: AuthLocks | null = null;
  let channel: AuthChannel | null = null;
  try {
    storage = globalThis.localStorage;
  } catch {
    /* Private sharing will be disabled. */
  }
  try {
    locks = globalThis.navigator?.locks;
  } catch {
    /* Capability absent. */
  }
  try {
    if (typeof BroadcastChannel === "function")
      channel = new BroadcastChannel(authControlName(apiMount));
  } catch {
    /* A channel is only an acceleration. */
  }
  return new AuthControl({
    apiMount,
    storage,
    locks,
    channel,
    events: typeof window === "undefined" ? undefined : window,
  });
}
