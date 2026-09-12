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
 * Extensions that describe how the bytes were compressed, not what they are:
 * `.gz` follows any data extension, so `dump.sql.gz` and `scan.nii.gz` are one
 * shape and enumerating the pairs would never be finished. `zip`, `7z` and
 * `rar` are archives in their own right — they hold several files, so they
 * never follow another extension, and the `bak` in `foo.bak.zip` is part of
 * the name.
 */
const COMPRESSION_SUFFIXES: Record<string, true> = {
  gz: true,
  bz2: true,
  xz: true,
  zst: true,
  lz4: true,
  lzma: true,
  lz: true,
  z: true,
  br: true,
};

/**
 * Compound extensions no rule can derive, where the segment before the dot is
 * a word rather than a format (`d`, `min`, `user`).
 */
const COMPOUND_EXTENSIONS: Record<string, true> = {
  "d.ts": true,
  "min.js": true,
  "min.css": true,
  "user.js": true,
};

/**
 * Split at the last dot, or at the one before it when the last two segments
 * form a compound extension. A name that begins with a dot and has no second
 * one (`.gitignore`) is all stem, so the id suffix lands at the end instead of
 * inside what a reader takes for the extension.
 *
 * The segment before a compression suffix has to look like an extension for
 * the pair to count, which keeps names that merely contain dots — the year in
 * `backup.2026.gz`, any non-ASCII stem in `截图.gz` — splitting at the last
 * dot. The check is a heuristic and misjudges some stems (`resume.final.gz`
 * reads as a compound extension), but the only thing at stake is which side of
 * a dot the id suffix lands on when two files on a card collide, and both
 * readings produce a usable name.
 */
export function splitName(name: string): { stem: string; ext: string } {
  const at = name.lastIndexOf(".");
  if (at <= 0) return { stem: name, ext: "" };

  const last = name.slice(at + 1).toLowerCase();
  const beforeAt = name.lastIndexOf(".", at - 1);
  if (beforeAt > 0) {
    const before = name.slice(beforeAt + 1, at);
    const compound =
      (COMPRESSION_SUFFIXES[last] === true && looksLikeExtension(before)) ||
      COMPOUND_EXTENSIONS[`${before}.${last}`.toLowerCase()] === true;
    if (compound) {
      return { stem: name.slice(0, beforeAt), ext: name.slice(beforeAt) };
    }
  }

  return { stem: name.slice(0, at), ext: name.slice(at) };
}

/** 1–8 ASCII alphanumerics, at least one of them not a digit. */
function looksLikeExtension(segment: string): boolean {
  return /^[A-Za-z0-9]{1,8}$/.test(segment) && !/^[0-9]+$/.test(segment);
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
