import type { Readable } from "node:stream";

/**
 * Attachment blob backend. `fs` streams through the server; a future `s3`
 * implementation returns presigned URLs from urlFor() and the download
 * route 302s to them instead of streaming.
 */
export type StorageBackend = {
  put(key: string, data: Uint8Array): Promise<void>;
  getStream(key: string): Promise<{ stream: Readable; size: number }>;
  delete(key: string): Promise<void>;
  /** Direct-access URL if the backend supports it (s3 presign); else null. */
  urlFor(key: string): Promise<string | null>;
};
