/**
 * The two platform APIs T-276 elects a leader on, faked well enough to run
 * several "tabs" in one process. Importing this module installs nothing; each
 * test calls `installTabSync` and restores in `afterEach`.
 */

type LockCallback = (lock: unknown) => unknown;
type RequestOptions = { ifAvailable?: boolean; signal?: AbortSignal };

type Waiter = {
  callback: LockCallback;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/**
 * FIFO locks in one process. Same grant order as Web Locks, but synchronous
 * where the real API is not — a test that needs the real asynchrony asserts
 * against the real `BroadcastChannel` instead (see tab-sync.test.ts).
 */
export class FakeLockManager {
  held = new Set<string>();
  queues = new Map<string, Waiter[]>();

  request(
    name: string,
    optionsOrCallback: RequestOptions | LockCallback,
    maybeCallback?: LockCallback,
  ): Promise<unknown> {
    const options =
      typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : (maybeCallback as LockCallback);

    if (options.signal?.aborted === true) {
      return Promise.reject(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    }
    if (!this.held.has(name)) return this.#grant(name, callback);
    if (options.ifAvailable === true) {
      return Promise.resolve(callback(null));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { callback, resolve, reject, ...options };
      waiter.onAbort = () => {
        const queue = this.queues.get(name) ?? [];
        this.queues.set(
          name,
          queue.filter((w) => w !== waiter),
        );
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      options.signal?.addEventListener("abort", waiter.onAbort);
      this.queues.set(name, [...(this.queues.get(name) ?? []), waiter]);
    });
  }

  #grant(name: string, callback: LockCallback): Promise<unknown> {
    this.held.add(name);
    const outcome = callback({ name, mode: "exclusive" });
    if (!(outcome instanceof Promise)) {
      // A callback that returns a plain value never held the lock for longer
      // than its own body, which is how the `ifAvailable` probe releases.
      this.held.delete(name);
      this.#pump(name);
      return Promise.resolve(outcome);
    }
    return outcome.then((value) => {
      this.held.delete(name);
      this.#pump(name);
      return value;
    });
  }

  #pump(name: string) {
    const queue = this.queues.get(name) ?? [];
    const next = queue.shift();
    this.queues.set(name, queue);
    if (next === undefined) return;
    if (next.onAbort !== undefined) {
      next.signal?.removeEventListener("abort", next.onAbort);
    }
    this.#grant(name, next.callback).then(next.resolve, next.reject);
  }
}

type ChannelListener = (e: MessageEvent) => void;

/**
 * Synchronous delivery, so the coalescing window can still be driven with
 * fake timers — the real `BroadcastChannel` delivers nothing at all under
 * them. The sender does not receive its own message, matching the spec.
 */
export class FakeBroadcastChannel {
  static registry = new Map<string, FakeBroadcastChannel[]>();
  name: string;
  onmessage: ChannelListener | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.registry.set(name, [
      ...(FakeBroadcastChannel.registry.get(name) ?? []),
      this,
    ]);
  }

  postMessage(data: unknown) {
    if (this.closed) {
      throw new DOMException("Channel is closed", "InvalidStateError");
    }
    for (const peer of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer === this || peer.closed) continue;
      peer.onmessage?.({ data } as MessageEvent);
    }
  }

  close() {
    this.closed = true;
    const peers = FakeBroadcastChannel.registry.get(this.name) ?? [];
    FakeBroadcastChannel.registry.set(
      this.name,
      peers.filter((peer) => peer !== this),
    );
  }
}

/**
 * Puts both fakes in place and returns the undo. `navigator.locks` is a
 * prototype getter in happy-dom, so an own property shadows it and `delete`
 * uncovers the original.
 */
export function installTabSync(): {
  locks: FakeLockManager;
  restore: () => void;
} {
  const locks = new FakeLockManager();
  Object.defineProperty(navigator, "locks", {
    value: locks,
    configurable: true,
    writable: true,
  });
  const realChannel = globalThis.BroadcastChannel;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
    FakeBroadcastChannel;
  return {
    locks,
    restore: () => {
      delete (navigator as unknown as { locks?: unknown }).locks;
      globalThis.BroadcastChannel = realChannel;
      FakeBroadcastChannel.registry.clear();
    },
  };
}
