/**
 * The passage of time as one injectable dependency, so the watch loop's
 * deadlines can be decided by arithmetic instead of by wall time (T-127).
 * Production reads the real clock; tests substitute a virtual one whose
 * `sleep` advances `now` without yielding, which is what keeps a
 * debounce-window assertion from turning into a bet on machine load.
 */
export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
