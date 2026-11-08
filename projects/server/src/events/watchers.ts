import type {
  AgentContext,
  ConnectionWatcherKind,
  WatcherKind,
  WatcherScope,
} from "@todou/shared";
import type { EventBus } from "./bus.ts";

/**
 * How long a released watcher stays listed (T-540). A reconnect after a
 * stall, a backoff (the CLI starts at 1s) or a server restart lands well
 * inside it and takes the entry over, so an avatar never flickers. The price
 * is that a watch which really ended stays visible for this long.
 */
export const WATCHER_LINGER_MS = 15_000;

export type WatcherClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const realClock: WatcherClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A linger must never hold the process open on shutdown.
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * What one connection declared. `all` holds the connection's own visible
 * map, which `streamChanges` keeps current as membership moves, so the
 * registry never queries membership itself.
 */
export type WatcherScopes =
  | { all: ReadonlyMap<number, unknown> }
  | { projects: readonly number[]; issues: ReadonlyArray<[number, number]> };

export type WatcherRegistration = {
  userId: number;
  agentContext: AgentContext;
  kind: ConnectionWatcherKind;
  /** Stands in for the session when the harness reported none. */
  connectionId: string;
  scopes: WatcherScopes;
};

/**
 * One listed watcher, before the route turns it into the wire DTO. An id
 * rather than the account row: a watch outlives renames and avatar changes,
 * and the row the connection authenticated with would go on showing the old
 * ones for as long as the watch lasts (T-571).
 */
export type WatcherView = {
  userId: number;
  agentContext: AgentContext;
  kind: WatcherKind;
  scope: WatcherScope;
  since: Date;
  /** Set on marks only. */
  expiresAt?: Date;
};

/** Who a mark belongs to, and on which card (T-669). */
export type WatchMarkTarget = {
  userId: number;
  agentContext: AgentContext;
  projectId: number;
  number: number;
};

export type WatcherHandle = {
  release(): void;
  /** The `all` scope's visible map changed; publish to what moved. */
  touch(): void;
};

type Entry = {
  key: string;
  userId: number;
  agentContext: AgentContext;
  kind: WatcherKind;
  scopes: WatcherScopes;
  since: number;
  /** The scopes of every live connection holding this entry, newest last. */
  holders: WatcherScopes[];
  /** The linger of a released entry, or a mark's expiry. */
  timer: unknown;
  /** Set on marks only. */
  expiresAt: number | null;
  /** The projects this entry was last published to — what `touch` diffs. */
  touched: Set<number>;
};

function scopeKey(scopes: WatcherScopes): string {
  if ("all" in scopes) return "all";
  return [
    ...scopes.projects.map((id) => `p${id}`),
    ...scopes.issues.map(([id, n]) => `i${id}/${n}`),
  ]
    .sort()
    .join(",");
}

/**
 * `marked` in the kind slot keeps a mark apart from the same session's own
 * `issue watch` connection, so the two are listed side by side.
 */
function markKey(target: WatchMarkTarget): string {
  return JSON.stringify([
    target.userId,
    target.agentContext.agent,
    target.agentContext.session_id ?? "",
    "marked",
    `i${target.projectId}/${target.number}`,
  ]);
}

function touchedBy(scopes: WatcherScopes): Set<number> {
  if ("all" in scopes) return new Set(scopes.all.keys());
  return new Set([...scopes.projects, ...scopes.issues.map(([id]) => id)]);
}

function byAge(a: WatcherView, b: WatcherView): number {
  return a.since.getTime() - b.since.getTime() || a.userId - b.userId;
}

/**
 * Who is watching what, live, in memory (T-540). Single-process for the same
 * reason `EventBus` is, and replaceable behind the same kind of interface.
 * A connection's lifetime is the watch's lifetime, so there is no sweeper:
 * a drop releases the entry. The linger and a mark's expiry are the only timers.
 */
export class WatcherRegistry {
  #bus: EventBus;
  #clock: WatcherClock;
  #lingerMs: number;
  #entries = new Map<string, Entry>();
  #disposed = false;

  constructor(
    bus: EventBus,
    opts: { clock?: WatcherClock; lingerMs?: number } = {},
  ) {
    this.#bus = bus;
    this.#clock = opts.clock ?? realClock;
    this.#lingerMs = opts.lingerMs ?? WATCHER_LINGER_MS;
  }

  register(reg: WatcherRegistration): WatcherHandle {
    const key = JSON.stringify([
      reg.userId,
      reg.agentContext.agent,
      reg.agentContext.session_id ?? `conn:${reg.connectionId}`,
      reg.kind,
      scopeKey(reg.scopes),
    ]);
    let entry = this.#entries.get(key);
    if (entry !== undefined) {
      // A take-over within the linger or a twin connection: same watcher,
      // original `since`, nothing for anyone to redraw.
      if (entry.timer !== null) {
        this.#clock.clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.holders.push(reg.scopes);
      entry.scopes = reg.scopes;
      entry.agentContext = reg.agentContext;
    } else {
      entry = {
        key,
        userId: reg.userId,
        agentContext: reg.agentContext,
        kind: reg.kind,
        scopes: reg.scopes,
        since: this.#clock.now(),
        holders: [reg.scopes],
        timer: null,
        expiresAt: null,
        touched: touchedBy(reg.scopes),
      };
      this.#entries.set(key, entry);
      this.#publish(entry, entry.touched);
    }
    // Twins collapse onto one map, the newest live connection's; the older
    // ones describe the same account and take over when it goes.
    const mine = reg.scopes;
    const owned = entry;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(owned, mine);
      },
      touch: () => {
        if (released || owned.scopes !== mine) return;
        const now = touchedBy(owned.scopes);
        const moved = new Set<number>();
        for (const id of now) if (!owned.touched.has(id)) moved.add(id);
        for (const id of owned.touched) if (!now.has(id)) moved.add(id);
        owned.touched = now;
        this.#publish(owned, moved);
      },
    };
  }

  #release(entry: Entry, scopes: WatcherScopes): void {
    entry.holders.splice(entry.holders.indexOf(scopes), 1);
    const newest = entry.holders.at(-1);
    if (newest !== undefined) {
      entry.scopes = newest;
      return;
    }
    if (this.#disposed) {
      this.#entries.delete(entry.key);
      return;
    }
    entry.timer = this.#clock.setTimeout(() => {
      entry.timer = null;
      if (this.#entries.get(entry.key) !== entry) return;
      if (entry.holders.length > 0) return;
      this.#entries.delete(entry.key);
      this.#publish(entry, entry.touched);
    }, this.#lingerMs);
  }

  /**
   * Sets or renews a mark: a card-level watcher no connection holds, gone
   * once `ttlMs` passes without a renewal (T-669). The TTL is already the
   * grace period, so there is no linger. A renewal changes nothing listed
   * but `expires_at`, so it publishes nothing.
   */
  mark(target: WatchMarkTarget & { ttlMs: number }): {
    since: Date;
    expiresAt: Date;
  } {
    const key = markKey(target);
    const now = this.#clock.now();
    let entry = this.#entries.get(key);
    const fresh = entry === undefined;
    if (entry === undefined) {
      const scopes: WatcherScopes = {
        projects: [],
        issues: [[target.projectId, target.number]],
      };
      entry = {
        key,
        userId: target.userId,
        agentContext: target.agentContext,
        kind: "marked",
        scopes,
        since: now,
        holders: [],
        timer: null,
        expiresAt: null,
        touched: touchedBy(scopes),
      };
      this.#entries.set(key, entry);
    } else {
      if (entry.timer !== null) this.#clock.clearTimeout(entry.timer);
      entry.agentContext = target.agentContext;
    }
    const owned = entry;
    owned.expiresAt = now + target.ttlMs;
    owned.timer = this.#clock.setTimeout(() => {
      owned.timer = null;
      if (this.#entries.get(owned.key) !== owned) return;
      this.#entries.delete(owned.key);
      this.#publish(owned, owned.touched);
    }, target.ttlMs);
    if (fresh) this.#publish(owned, owned.touched);
    return {
      since: new Date(owned.since),
      expiresAt: new Date(owned.expiresAt),
    };
  }

  /** Drops a mark at once; false when there was none. */
  unmark(target: WatchMarkTarget): boolean {
    const entry = this.#entries.get(markKey(target));
    if (entry === undefined) return false;
    if (entry.timer !== null) this.#clock.clearTimeout(entry.timer);
    entry.timer = null;
    this.#entries.delete(entry.key);
    this.#publish(entry, entry.touched);
    return true;
  }

  /** Clears every pending linger and mark, so shutdown and tests never wait them out. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      if (entry.timer !== null) this.#clock.clearTimeout(entry.timer);
      entry.timer = null;
      if (entry.holders.length === 0) this.#entries.delete(entry.key);
    }
  }

  #publish(entry: Entry, projectIds: Iterable<number>): void {
    for (const projectId of projectIds) {
      // Card-level only when the entry declares nothing broader here, and a
      // single card: anything else asks the reader to refetch the project.
      let issueNumber: number | undefined;
      if (
        !("all" in entry.scopes) &&
        !entry.scopes.projects.includes(projectId)
      ) {
        const numbers = entry.scopes.issues
          .filter(([id]) => id === projectId)
          .map(([, n]) => n);
        if (numbers.length === 1) issueNumber = numbers[0];
      }
      this.#bus.publish(projectId, {
        entity: "watchers",
        action: "updated",
        id: projectId,
        ...(issueNumber === undefined ? {} : { issue_number: issueNumber }),
      });
    }
  }

  /**
   * The account's name, login or avatar changed. Every surface listing one
   * of its watchers refetches; nothing else would tell them until the watch
   * ended.
   */
  userChanged(userId: number): void {
    for (const entry of this.#entries.values()) {
      if (entry.userId === userId) this.#publish(entry, entry.touched);
    }
  }

  #view(entry: Entry, scope: WatcherScope): WatcherView {
    return {
      userId: entry.userId,
      agentContext: entry.agentContext,
      kind: entry.kind,
      scope,
      since: new Date(entry.since),
      ...(entry.expiresAt === null
        ? {}
        : { expiresAt: new Date(entry.expiresAt) }),
    };
  }

  /** `project` watchers of the project, plus `all` watchers whose account can read it. */
  projectWatchers(projectId: number): WatcherView[] {
    const out: WatcherView[] = [];
    for (const entry of this.#entries.values()) {
      if ("all" in entry.scopes) {
        if (entry.scopes.all.has(projectId)) {
          out.push(this.#view(entry, "all_projects"));
        }
      } else if (entry.scopes.projects.includes(projectId)) {
        out.push(this.#view(entry, "project"));
      }
    }
    return out.sort(byAge);
  }

  issueWatchers(projectId: number): Map<number, WatcherView[]> {
    const out = new Map<number, WatcherView[]>();
    for (const entry of this.#entries.values()) {
      if ("all" in entry.scopes) continue;
      const numbers = new Set(
        entry.scopes.issues
          .filter(([id]) => id === projectId)
          .map(([, n]) => n),
      );
      for (const number of numbers) {
        let list = out.get(number);
        if (list === undefined) {
          list = [];
          out.set(number, list);
        }
        list.push(this.#view(entry, "issue"));
      }
    }
    for (const list of out.values()) list.sort(byAge);
    return out;
  }

  size(): number {
    return this.#entries.size;
  }
}
