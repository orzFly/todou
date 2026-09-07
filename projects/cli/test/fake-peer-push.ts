import { systemClock } from "../src/clock.ts";
import type { PeerPush, PeerPushOptions, Rejection } from "../src/peer-push.ts";

export type FakePush = {
  /** Injected through CliContext in place of the real socket transport. */
  open: <T>(opts: PeerPushOptions<T>) => Promise<PeerPush<T>>;
  /** Every push in order: the rendered body and the range it claimed. */
  pushes: Array<{
    body: string;
    since: string | undefined;
    cursor: string | undefined;
    mode: string | undefined;
  }>;
  /** The display name the channel was opened with; unset until it opens. */
  fromName: string | undefined;
  closed: () => boolean;
};

/**
 * A stand-in for the cross-session transport, faithful about the three
 * things the command depends on: a `send` that returns before any verdict is
 * in, a receipt window after which a batch counts as landed, and a
 * `fromMode` asked once per push rather than once per channel (T-292). The
 * wire format itself is `peer-push.test.ts`'s business.
 *
 * The third one is faithfulness the compiler cannot ask for: `fromMode` is
 * optional, so a fake that never called it would still typecheck — and every
 * assertion about an attested mode would pass while testing nothing.
 */
export function fakePeerPush(
  opts: {
    /** Refuse the channel a beat after the nth send (1-based). */
    rejectAfter?: { send: number; rejection: Rejection };
    /** Fail to open at all, the way a bind collision does. */
    failOpen?: Error;
    /** Replies the listener discarded, seeded the way a rejection is. */
    replies?: { discarded: number; unbounced: number };
  } = {},
): FakePush {
  const pushes: FakePush["pushes"] = [];
  let closed = false;
  let rejected: Rejection | null = null;
  let announce = () => {};
  const whenRejected = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const state: { fromName: string | undefined } = { fromName: undefined };

  async function open<T>(o: PeerPushOptions<T>): Promise<PeerPush<T>> {
    if (opts.failOpen) throw opts.failOpen;
    state.fromName = o.fromName;
    const clock = o.clock ?? systemClock;
    const windowMs = o.receiptWindowMs ?? 30_000;
    const held: Array<{
      items: T[];
      since: string | undefined;
      cursor: string | undefined;
      expiresAt: number;
    }> = [];
    const prune = () => {
      while ((held[0]?.expiresAt ?? Number.POSITIVE_INFINITY) <= clock.now()) {
        held.shift();
      }
    };
    return {
      send: async (items, since, cursor) => {
        const mode = o.fromMode?.();
        pushes.push({
          body: o.render(items, since, cursor),
          since,
          cursor,
          mode,
        });
        held.push({
          items: [...items],
          since,
          cursor,
          expiresAt: clock.now() + windowMs,
        });
        if (opts.rejectAfter?.send === pushes.length) {
          const { rejection } = opts.rejectAfter;
          // A receipt arrives over a connection of its own, after the write
          // has already returned — so the caller sees a clean send and
          // learns of the refusal once it is back to waiting. A timer, not
          // a microtask, is what puts it on the far side of that.
          setTimeout(() => {
            rejected = rejection;
            announce();
          }, 0);
        }
      },
      get rejected() {
        return rejected;
      },
      unconfirmed: () => {
        prune();
        return {
          items: held.flatMap((batch) => batch.items),
          since: held[0]?.since,
          cursor: held.at(-1)?.cursor,
        };
      },
      replies: () => opts.replies ?? { discarded: 0, unbounced: 0 },
      whenRejected,
      close: () => {
        closed = true;
      },
    };
  }

  return {
    open,
    pushes,
    get fromName() {
      return state.fromName;
    },
    closed: () => closed,
  };
}
