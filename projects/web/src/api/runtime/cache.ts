import type { ResourceDescriptor } from "./resources.ts";

export interface CompletedValue<T = unknown> {
  descriptor: ResourceDescriptor;
  data: T;
  fetchedAt: number;
  generation: number;
  revision: number;
  payloadBytes: number;
  accessedAt: number;
}
export interface CacheLimits {
  maxEntryBytes: number;
  maxBytes: number;
  maxEntries: number;
  idleMs: number;
}
export const DEFAULT_CACHE_LIMITS: CacheLimits = {
  maxEntryBytes: 2 * 1024 * 1024,
  maxBytes: 32 * 1024 * 1024,
  maxEntries: 2000,
  idleMs: 5 * 60_000,
};
export function payloadBytes(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data) ?? "null").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Only completed successful server values live here. Map order is LRU order. */
export class CompletedCache {
  private readonly values = new Map<string, CompletedValue>();
  private readonly pins = new Map<string, number>();
  private bytes = 0;
  readonly limits: CacheLimits;
  private readonly onEvict?: (id: string) => void;
  constructor(
    limits: Partial<CacheLimits> = {},
    onEvict?: (id: string) => void,
  ) {
    this.limits = { ...DEFAULT_CACHE_LIMITS, ...limits };
    this.onEvict = onEvict;
  }
  get size(): number {
    return this.values.size;
  }
  get totalBytes(): number {
    return this.bytes;
  }
  get(id: string, now?: number): CompletedValue | undefined {
    const value = this.values.get(id);
    if (value && now !== undefined) {
      value.accessedAt = now;
      this.values.delete(id);
      this.values.set(id, value);
    }
    return value;
  }
  set(id: string, value: CompletedValue): boolean {
    const limit = Math.min(this.limits.maxEntryBytes, this.limits.maxBytes);
    if (
      !Number.isFinite(value.payloadBytes) ||
      value.payloadBytes > limit ||
      this.limits.maxEntries < 1
    ) {
      this.delete(id);
      return false;
    }
    const previous = this.values.get(id);
    const requiredBytes =
      this.bytes - (previous?.payloadBytes ?? 0) + value.payloadBytes;
    let freed = 0;
    const victims: string[] = [];
    for (const [key, entry] of this.values) {
      if (
        requiredBytes - freed <= this.limits.maxBytes &&
        this.values.size - (previous ? 1 : 0) - victims.length + 1 <=
          this.limits.maxEntries
      )
        break;
      if (key === id || this.pins.has(key)) continue;
      victims.push(key);
      freed += entry.payloadBytes;
    }
    if (
      requiredBytes - freed > this.limits.maxBytes ||
      this.values.size - (previous ? 1 : 0) - victims.length + 1 >
        this.limits.maxEntries
    ) {
      this.delete(id);
      return false;
    }
    for (const victim of victims) this.delete(victim);
    if (previous) this.bytes -= previous.payloadBytes;
    this.values.delete(id);
    this.values.set(id, value);
    this.bytes += value.payloadBytes;
    return true;
  }
  pin(id: string): void {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
  }
  unpin(id: string, now: number): void {
    const count = this.pins.get(id) ?? 0;
    if (count > 1) this.pins.set(id, count - 1);
    else {
      this.pins.delete(id);
      const value = this.values.get(id);
      if (value) value.accessedAt = now;
    }
  }
  delete(id: string): void {
    const value = this.values.get(id);
    if (!value) return;
    this.values.delete(id);
    this.bytes -= value.payloadBytes;
    this.onEvict?.(id);
  }
  sweep(now: number): void {
    for (const [id, value] of this.values)
      if (!this.pins.has(id) && now - value.accessedAt >= this.limits.idleMs)
        this.delete(id);
  }
  clear(): void {
    for (const id of this.values.keys()) this.delete(id);
    this.pins.clear();
  }
}
