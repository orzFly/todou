import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** A literal name, or a test standing in for one `*`-shaped segment. */
export type PathSegment = string | ((name: string) => boolean);

/**
 * The first existing path below `root` whose segments match `segments`, one
 * directory listing per wildcard level — what a glob with one `*` per segment
 * answers, without the glob implementation the CLI's single-file runtime does
 * not have (T-792).
 *
 * Wildcard levels are walked in sorted order and skip dot-entries, as a glob's
 * `*` does; a literal segment is looked up directly rather than listed for.
 * Every unreadable level is a dead end, never an error.
 */
export async function findPath(
  root: string,
  segments: readonly PathSegment[],
): Promise<string | undefined> {
  const [segment, ...rest] = segments;
  if (segment === undefined) return root;
  if (typeof segment === "string") {
    const path = join(root, segment);
    if (rest.length > 0) return findPath(path, rest);
    try {
      await stat(path);
      return path;
    } catch {
      return undefined;
    }
  }
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  for (const name of names.sort()) {
    if (name.startsWith(".") || !segment(name)) continue;
    const found =
      rest.length > 0
        ? await findPath(join(root, name), rest)
        : join(root, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Any name a glob's bare `*` matches. */
export const anyName = (): boolean => true;
