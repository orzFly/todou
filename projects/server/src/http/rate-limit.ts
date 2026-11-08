import { isIP } from "node:net";

/**
 * Sliding-window counter held in this process's memory: a restart forgets
 * it, and several server processes would each count on their own. Enough
 * for a single-process deployment; anything wider belongs in the proxy.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private nextPrune = 0;
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
    // growing the map without bound. Once a window at most: a sweep on every
    // take would walk every live key per request, so a flood from many
    // addresses would cost each request as much as the flood is wide (T-649).
    if (this.hits.size > 1000 && now >= this.nextPrune) {
      for (const [k, times] of this.hits) {
        if ((times.at(-1) ?? 0) <= since) this.hits.delete(k);
      }
      this.nextPrune = now + this.windowMs;
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

/**
 * The bucket an address is counted in. One IPv6 subscriber is routinely
 * handed a whole /64, so counting single IPv6 addresses would give one
 * client 2^64 separate allowances.
 */
export function rateLimitKey(addr: string): string {
  if (isIP(addr) !== 6) return addr;
  const bare = addr.split("%")[0] ?? addr;
  const [head = "", tail] = bare.split("::");
  const groups = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const zeros = Array<string>(8 - front.length - back.length).fill("0");
  const full = [...front, ...zeros, ...back];
  return `${full
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}
