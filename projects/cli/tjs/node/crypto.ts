// node:crypto for the tjs build: Web Crypto for randomness, tjs:hashing for
// digests.

import { createHash as createTjsHash, type HashType } from "tjs:hashing";
import { Buffer } from "buffer";

export function randomUUID(): string {
  return crypto.randomUUID();
}

// getRandomValues refuses more than 65536 bytes per call.
export function randomBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let at = 0; at < size; at += 65536) {
    crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
  }
  return bytes;
}

class Hash {
  readonly #hash: ReturnType<typeof createTjsHash>;

  constructor(algorithm: string) {
    this.#hash = createTjsHash(algorithm.toLowerCase() as HashType);
  }

  update(data: string | Uint8Array): this {
    this.#hash.update(
      typeof data === "string" ? new TextEncoder().encode(data) : data,
    );
    return this;
  }

  digest(): Buffer;
  digest(encoding: "hex" | "base64" | "base64url"): string;
  digest(encoding?: "hex" | "base64" | "base64url"): Buffer | string {
    const bytes = Buffer.from(this.#hash.bytes());
    return encoding === undefined ? bytes : bytes.toString(encoding);
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithm);
}
