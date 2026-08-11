import type { ChangeEvent } from "@todou/shared";

export type Subscriber = (event: ChangeEvent) => void;

/**
 * In-process, per-project fan-out. Services publish AFTER their transaction
 * commits so subscribers always refetch committed data. Single-process by
 * design for this slice; a pg NOTIFY implementation can replace it behind
 * the same interface for multi-instance deployments.
 */
export class EventBus {
  #subscribers = new Map<number, Set<Subscriber>>();

  subscribe(projectId: number, fn: Subscriber): () => void {
    let set = this.#subscribers.get(projectId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(projectId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#subscribers.delete(projectId);
    };
  }

  publish(projectId: number, event: ChangeEvent): void {
    for (const fn of this.#subscribers.get(projectId) ?? []) {
      try {
        fn(event);
      } catch {
        // One broken subscriber must never break the others.
      }
    }
  }

  subscriberCount(projectId: number): number {
    return this.#subscribers.get(projectId)?.size ?? 0;
  }
}
