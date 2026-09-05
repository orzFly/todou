/**
 * Filenames are unique within one card (T-269). The rule lives here rather
 * than beside the upload paths because three callers need the same yardstick:
 * both upload paths, and the `attachments relabel` command that rewrites the
 * link text left behind by the migration.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/driver.ts";
import { attachments } from "../db/project-schema.ts";

export function sanitizeFilename(name: string): string {
  const cleaned = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replaceAll(/[\u0000-\u001f/\\:"'<>|?*]/g, "_")
    .replaceAll("..", "_")
    .trim();
  // The server is the only writer, so folding to NFC at the entrance is what
  // lets `nameKey` compare with a single fold and the unique index stay a
  // plain `lower()` — no normaliser inside the index expression.
  return (cleaned === "" ? "attachment" : cleaned.slice(0, 200)).normalize(
    "NFC",
  );
}

/**
 * encodeURIComponent leaves ( ) ' ! * alone; parentheses would terminate
 * a markdown `](…)` destination early, and these URLs get pasted into
 * markdown bodies verbatim.
 */
export function encodeNameSegment(name: string): string {
  return encodeURIComponent(name).replaceAll("(", "%28").replaceAll(")", "%29");
}

/**
 * Split at the last dot. A name that begins with a dot and has no second one
 * (`.gitignore`) is all stem, so the id suffix lands at the end instead of
 * inside what a reader takes for the extension.
 */
export function splitName(name: string): { stem: string; ext: string } {
  const at = name.lastIndexOf(".");
  if (at <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, at), ext: name.slice(at) };
}

/** The yardstick uniqueness is measured with, matching `lower(filename)`. */
export function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function withIdSuffix(name: string, id: number): string {
  const { stem, ext } = splitName(name);
  return `${stem}-${id}${ext}`;
}

export async function takenNames(
  db: Db,
  issueId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ filename: attachments.filename })
    .from(attachments)
    .where(eq(attachments.issueId, issueId));
  return new Set(rows.map((row) => nameKey(row.filename)));
}

/**
 * The free name nearest `requested`, given the names this card already holds.
 * `foo.png` becomes `foo-813.png`; if someone really did upload a file called
 * `foo-813.png`, it walks on to `foo-813-2.png`. Bounded: every step adds a
 * counter the previous candidates do not carry.
 */
export function resolveCollision(
  taken: ReadonlySet<string>,
  requested: string,
  id: number,
): string {
  const suffixed = withIdSuffix(requested, id);
  if (!taken.has(nameKey(suffixed))) return suffixed;
  const { stem, ext } = splitName(suffixed);
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}
