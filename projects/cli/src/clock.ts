/**
 * The passage of time as one injectable dependency, so the watch loop's
 * deadlines can be decided by arithmetic instead of by wall time (T-127).
 * Production reads the real clock; tests substitute a virtual one whose
 * `sleep` advances `now` instead of waiting, which is what keeps a
 * debounce-window assertion from turning into a bet on machine load.
 */
export type Clock = {
  now: () => number;
  /**
   * Resolves after `ms`, or as soon as `signal` aborts — whichever comes
   * first. Cancellation is not a convenience: a watch that races this
   * against an SSE nudge (T-123) abandons a sleep that can be twelve hours
   * long, and an uncancelled timer would keep the process alive for all of
   * it after the command has already printed its result.
   */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
