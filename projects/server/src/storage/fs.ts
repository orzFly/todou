import { createReadStream, type Dir } from "node:fs";
import { mkdir, opendir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { NotFoundError } from "../errors.ts";
import type { StorageBackend, StoredObject } from "./types.ts";

export class FsStorage implements StorageBackend {
  #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #resolve(key: string): string {
    const path = normalize(join(this.#root, key));
    // Keys are server-generated, but never trust a stored value enough to
    // escape the root.
    if (!path.startsWith(normalize(this.#root) + sep)) {
      throw new NotFoundError("attachment blob not found");
    }
    return path;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const path = this.#resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async getStream(key: string) {
    const path = this.#resolve(key);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      throw new NotFoundError("attachment blob not found");
    }
    return { stream: createReadStream(path), size };
  }

  async delete(key: string): Promise<void> {
    await rm(this.#resolve(key), { force: true });
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      return { size: (await stat(this.#resolve(key))).size };
    } catch {
      return null;
    }
  }

  async urlFor(): Promise<string | null> {
    return null;
  }

  async *list(): AsyncIterable<StoredObject> {
    yield* this.#walk(this.#root, "");
  }

  async *#walk(dir: string, prefix: string): AsyncIterable<StoredObject> {
    let handle: Dir;
    try {
      handle = await opendir(dir);
    } catch (err) {
      // A root nothing was ever stored under does not exist yet.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for await (const entry of handle) {
      const path = join(dir, entry.name);
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        yield* this.#walk(path, `${key}/`);
      } else if (entry.isFile()) {
        const info = await stat(path);
        yield { key, size: info.size, modifiedAt: info.mtime };
      }
    }
  }
}
