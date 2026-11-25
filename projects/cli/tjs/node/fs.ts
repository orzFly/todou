// node:fs for the tjs build: only `constants` and `openAsBlob`. Everything
// else the CLI does with files goes through node:fs/promises.
import { readFile } from "./fs-promises.ts";

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
} as const;

/**
 * Node hands back a Blob backed by the file. tjs has no such Blob, so the
 * file is read whole; an attachment is bounded by the server's upload limit
 * anyway.
 */
export async function openAsBlob(
  path: string,
  options?: { type?: string },
): Promise<Blob> {
  const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
  return new Blob([bytes], { type: options?.type ?? "" });
}
