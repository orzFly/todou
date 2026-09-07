/**
 * Leader election and delivery between the tabs of one account (T-276), on
 * three platform APIs and nothing else — this module does not know about
 * react-query. `useUserEvents` owns what travels; this owns who is allowed to
 * connect and how a frame reaches the others.
 */

/**
 * A frame on the channel between tabs. Two bundle versions are live in one
 * browser during a deploy, so this is a wire format: it carries a version and
 * a reader that cannot recognize it drops the message. Doing nothing is the
 * safe side — react-query's focus refetch and the next `gap` both cover it.
 *
 * `data` means two different things on purpose. On `change` / `me` it is the
 * unparsed SSE frame text, so every tab decides with its own schema what to
 * touch; on `data` it is a parsed response body, which the receiver adopts as
 * it stands.
 */
export type TabMessage =
  | { v: 1; frame: "change"; data: string }
  | { v: 1; frame: "me"; data: string }
  | { v: 1; frame: "gap" }
  | { v: 1; frame: "data"; key: unknown[]; data: unknown; at: number };

/**
 * Both APIs or neither: a lock that elects a leader whose frames cannot reach
 * anyone leaves the followers as mute windows, which is worse than not
 * sharing at all.
 */
export function tabSyncSupported(): boolean {
  // Truthiness, not `in` or `typeof`: happy-dom's `navigator.locks` is a
  // getter returning `null`, so both of those report support and then throw
  // on `.request`.
  const locks = globalThis.navigator?.locks as unknown;
  return Boolean(locks) && typeof globalThis.BroadcastChannel === "function";
}

export type TabChannel = {
  post: (msg: TabMessage) => void;
  close: () => void;
};

/**
 * A `BroadcastChannel` that only ever hands up frames of a version this
 * bundle knows, and whose `post` / `close` stay callable after it is closed —
 * a teardown racing an in-flight frame is ordinary, not an error.
 */
export function openTabChannel(
  name: string,
  onMessage: (msg: TabMessage) => void,
): TabChannel {
  const channel = new BroadcastChannel(name);
  let closed = false;
  channel.onmessage = (e: MessageEvent) => {
    const msg = e.data as { v?: unknown } | null;
    if (typeof msg !== "object" || msg === null || msg.v !== 1) return;
    onMessage(msg as TabMessage);
  };
  return {
    post: (msg) => {
      if (closed) return;
      channel.postMessage(msg);
    },
    close: () => {
      if (closed) return;
      closed = true;
      channel.close();
    },
  };
}

/** The probe's way of saying "somebody else holds it". */
const PROBE_MISSED = Symbol("tab-sync probe missed");

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Runs `lead` for as long as this tab holds `name`, and returns the way to
 * give the role up (idempotent, and safe before the lock is ever granted).
 *
 * `lead` is told how it got here, because the two paths need different
 * repair. An `{ ifAvailable: true }` probe that succeeds means no leader
 * existed when this tab mounted, so its cache is the cold one it just
 * created and needs no compensation. A probe that misses and a later
 * blocking grant means the previous leader died: this cache is warm and
 * missed whatever arrived in the ownerless window, so it must compensate.
 * Without the split, either every cold load pays an extra round of
 * invalidations or a promoted tab runs on a cache with a hole in it.
 */
export function electLeader(
  name: string,
  lead: (info: { promoted: boolean }) => () => void,
): () => void {
  const locks = globalThis.navigator.locks;
  const queued = new AbortController();
  let released = false;
  let stopLeading: (() => void) | undefined;
  let releaseLock: (() => void) | undefined;

  // The standard shape for holding a Web Lock: the callback returns a promise
  // that stays pending until we choose to let go.
  const hold = (promoted: boolean) =>
    new Promise<void>((resolve) => {
      if (released) {
        resolve();
        return;
      }
      releaseLock = resolve;
      stopLeading = lead({ promoted });
    });

  void locks
    .request(name, { ifAvailable: true }, (held) =>
      held === null ? PROBE_MISSED : hold(false),
    )
    .then((outcome) => {
      if (outcome !== PROBE_MISSED || released) return;
      // `signal` only cancels a request that is still queued; once granted,
      // letting go means resolving the promise above.
      return locks
        .request(name, { signal: queued.signal }, () => hold(true))
        .catch((error: unknown) => {
          if (!isAbort(error)) throw error;
        });
    });

  return () => {
    if (released) return;
    released = true;
    queued.abort();
    // Torn down before the lock is released, so the next leader cannot open
    // its connection while this tab's is still running.
    stopLeading?.();
    stopLeading = undefined;
    releaseLock?.();
    releaseLock = undefined;
  };
}
