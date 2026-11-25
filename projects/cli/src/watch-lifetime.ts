import { type Clock, systemClock } from "./clock.ts";
import type { Env } from "./config.ts";
import {
  type NativeWatchOwner,
  nativeWatchOwner,
} from "./harness/messaging.ts";
import { readOmpStateAt } from "./harness/omp-state.ts";
import type { ProcessTreeIo } from "./harness/process-tree.ts";

/** Independent of tracker polling, retry backoff, and the batch window. */
const OWNER_CHECK_MS = 1_000;

export type WatchLifetime = {
  owner: NativeWatchOwner;
  signal: AbortSignal;
  clock: Clock;
  close(): void;
};

/** Only a verified, rereadable native owner can bind a raw watch's lifetime. */
export async function openWatchLifetime(opts: {
  env: Env;
  io?: Partial<ProcessTreeIo>;
  clock?: Clock;
  note: (line: string) => void;
  /** Tests can mutate the same snapshot without a real process tree. */
  readOwner?: () => Promise<NativeWatchOwner | undefined>;
}): Promise<WatchLifetime | undefined> {
  const readOwner =
    opts.readOwner ?? (() => nativeWatchOwner(opts.env, opts.io));
  const initial = await readOwner();
  if (initial === undefined) return undefined;
  // Own the values, even when a test reader returns a mutable object.
  const owner = { ...initial };
  // Ancestry proves ownership once. A background shell may then exit and
  // reparent the watch without retiring the still-live native owner.
  const readCapturedOwner =
    opts.readOwner ??
    (async () => {
      const state = await readOmpStateAt(owner.path);
      if (
        state === undefined ||
        state.socket === undefined ||
        state.token === undefined
      )
        return undefined;
      const peer = state.agent ?? "omp";
      if (peer !== "omp" && peer !== "pi") return undefined;
      return {
        peer,
        pid: state.pid,
        path: state.path,
        sessionId: state.sessionId,
        socket: state.socket,
        token: state.token,
      };
    });
  const abort = new AbortController();
  const clock = opts.clock ?? systemClock;
  // A read is asynchronous now, so a slow one could still be running when
  // the next tick fires, or when the watch has already been closed; neither
  // may produce a second verdict.
  let checking = false;
  let closed = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const live = await readCapturedOwner();
      if (closed) return;
      if (
        live !== undefined &&
        live.peer === owner.peer &&
        live.pid === owner.pid &&
        live.path === owner.path &&
        live.sessionId === owner.sessionId &&
        live.socket === owner.socket &&
        live.token === owner.token
      ) {
        return;
      }
      closed = true;
      clearInterval(timer);
      opts.note("watch stopped: native session owner changed or disappeared");
      abort.abort();
    } finally {
      checking = false;
    }
  }, OWNER_CHECK_MS);
  // Optional: on a runtime whose timers are plain numbers there is nothing to
  // unref, and the single-file build exits once the command returns anyway.
  timer.unref?.();
  return {
    owner,
    signal: abort.signal,
    clock: {
      now: clock.now,
      sleep: (ms, signal) =>
        clock.sleep(
          ms,
          signal === undefined
            ? abort.signal
            : AbortSignal.any([signal, abort.signal]),
        ),
    },
    close: () => {
      closed = true;
      clearInterval(timer);
      abort.abort();
    },
  };
}
