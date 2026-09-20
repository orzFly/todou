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
export function openWatchLifetime(opts: {
  env: Env;
  io?: Partial<ProcessTreeIo>;
  clock?: Clock;
  note: (line: string) => void;
  /** Tests can mutate the same snapshot without a real process tree. */
  readOwner?: () => NativeWatchOwner | undefined;
}): WatchLifetime | undefined {
  const readOwner =
    opts.readOwner ?? (() => nativeWatchOwner(opts.env, opts.io));
  const initial = readOwner();
  if (initial === undefined) return undefined;
  // Own the values, even when a test reader returns a mutable object.
  const owner = { ...initial };
  // Ancestry proves ownership once. A background shell may then exit and
  // reparent the watch without retiring the still-live native owner.
  const readCapturedOwner =
    opts.readOwner ??
    (() => {
      const state = readOmpStateAt(owner.path);
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
  const timer = setInterval(() => {
    const live = readCapturedOwner();
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
    clearInterval(timer);
    opts.note("watch stopped: native session owner changed or disappeared");
    abort.abort();
  }, OWNER_CHECK_MS);
  timer.unref();
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
      clearInterval(timer);
      abort.abort();
    },
  };
}
