import type { ChangeEvent } from "@todou/shared";

export type Subscriber = (projectId: number, event: ChangeEvent) => void;

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
}
