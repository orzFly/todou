/**
 * Sliding-window counter held in this process's memory: a restart forgets
 * it, and several server processes would each count on their own. Enough
 * for a single-process deployment; anything wider belongs in the proxy.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Records a hit and returns 0, or the seconds until one is allowed again. */
  take(key: string): number {
    const now = this.now();
    const since = now - this.windowMs;
    // Sweeping on the way in keeps a stream of one-off addresses from
    // growing the map without bound.
    if (this.hits.size > 1000) {
      for (const [k, times] of this.hits) {
        if ((times.at(-1) ?? 0) <= since) this.hits.delete(k);
      }
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }
}
