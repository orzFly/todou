import type { ChangeEvent, MeEvent } from "@todou/shared";

export type Subscriber = (projectId: number, event: ChangeEvent) => void;

export type MeSubscriber = (event: MeEvent) => void;

/**
 * In-process fan-out. Services publish AFTER their transaction commits so
 * subscribers always refetch committed data. Subscribers receive every
 * project's events and filter for themselves: a user-level stream's visible
 * set changes with membership, and the events that change it (member,
 * project) are published on the very project the subscriber may not be
 * following yet — a per-project fan-out could never deliver those (T-122).
 * Single-process by design for this slice; a pg NOTIFY implementation on a
 * single channel carrying the projectId can replace it behind the same
 * interface for multi-instance deployments.
 */
export class EventBus {
  #subscribers = new Set<Subscriber>();

  subscribe(fn: Subscriber): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
    };
  }

  publish(projectId: number, event: ChangeEvent): void {
    for (const fn of this.#subscribers) {
      try {
        fn(projectId, event);
      } catch {
        // One broken subscriber must never break the others.
      }
    }
  }

  subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * Events addressed to one user (T-275). Routed by user id rather than
   * fanned out to everyone the way `publish` is: a read position and a
   * preference are the user's private state, and routing that has to hold
   * only because every subscriber remembers to check the id itself would
   * leak the first time one of them forgets.
   */
  #meSubscribers = new Map<number, Set<MeSubscriber>>();

  subscribeMe(userId: number, fn: MeSubscriber): () => void {
    let set = this.#meSubscribers.get(userId);
    if (set === undefined) {
      set = new Set();
      this.#meSubscribers.set(userId, set);
    }
    set.add(fn);
    return () => {
      const current = this.#meSubscribers.get(userId);
      if (current === undefined) return;
      current.delete(fn);
      if (current.size === 0) this.#meSubscribers.delete(userId);
    };
  }

  publishMe(userId: number, event: MeEvent): void {
    const set = this.#meSubscribers.get(userId);
    if (set === undefined) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // One broken subscriber must never break the others.
      }
    }
  }

  /**
   * Whether anyone is listening for this user. Write paths ask first so the
   * fingerprint behind an `issue_read` event is only computed when some
   * connection will actually read it — the same rule `?inbox=1` follows.
   */
  hasMeSubscriber(userId: number): boolean {
    return this.#meSubscribers.has(userId);
  }
}
