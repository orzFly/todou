import type { Readable } from "node:stream";

/**
 * Attachment blob backend. `fs` streams through the server; a future `s3`
 * implementation returns presigned URLs from urlFor() and the download
 * route 302s to them instead of streaming.
 */
export type StorageBackend = {
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * With `range`, the stream carries bytes `start` through `end` inclusive
   * and `size` counts those bytes, not the object's. The caller has already
   * resolved the range against the object's size; nothing here re-checks it.
   */
  getStream(
    key: string,
    range?: ByteSpan,
  ): Promise<{ stream: Readable; size: number }>;
  delete(key: string): Promise<void>;
  /** Size probe; null when the blob does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  /** Direct-access URL if the backend supports it (s3 presign); else null. */
  urlFor(
    key: string,
    opts?: { filename?: string; contentType?: string },
  ): Promise<string | null>;
  /**
   * Every stored object, a page at a time; keys as the database stores them,
   * without the deployment's prefix. Costs one request per page, so only
   * the operator's `storage orphans` calls it — never a periodic pass.
   */
  list(opts?: { pageSize?: number }): AsyncIterable<StoredObject>;
};

export type StoredObject = { key: string; size: number; modifiedAt: Date };

export type ByteSpan = { start: number; end: number };
