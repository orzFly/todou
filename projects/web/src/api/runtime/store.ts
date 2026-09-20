import type { InvalidationTarget, ResourceDescriptor } from "./resources.ts";

export interface StoreScope {
  origin: string;
  apiMount: string;
  accountId: string;
  epoch: number;
  descriptor?: ResourceDescriptor;
}
export interface SnapshotRecord extends StoreScope {
  schemaVersion: 1;
  descriptor: ResourceDescriptor;
  projectId?: string | number;
  payload: unknown;
  fetchedAt: number;
  generation: number;
  payloadBytes: number;
}
export type StoreGuard = () => boolean;
export interface SnapshotStore {
  load(
    scope: StoreScope,
    signal: AbortSignal,
  ): Promise<readonly SnapshotRecord[]>;
  put(record: SnapshotRecord, guard: StoreGuard): Promise<void>;
  invalidateScope(scope: InvalidationTarget, generation: number): Promise<void>;
  clearAccount(accountId: string, epoch: number): Promise<void>;
}

/** Persistence is deliberately absent; the runtime still guards async seams. */
export class EmptySnapshotStore implements SnapshotStore {
  async load(
    _scope: StoreScope,
    _signal: AbortSignal,
  ): Promise<readonly SnapshotRecord[]> {
    return [];
  }
  async put(_record: SnapshotRecord, _guard: StoreGuard): Promise<void> {}
  async invalidateScope(
    _scope: InvalidationTarget,
    _generation: number,
  ): Promise<void> {}
  async clearAccount(_accountId: string, _epoch: number): Promise<void> {}
}
export const emptySnapshotStore: SnapshotStore = new EmptySnapshotStore();
