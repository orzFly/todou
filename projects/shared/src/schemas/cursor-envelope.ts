import { z } from "zod";
import { Cursor } from "./common.ts";
import { ProjectSlug } from "./project.ts";

/**
 * The multi-project cursor envelope behind `GET /activity` (T-93).
 *
 * A plain activity cursor is a position whose tie-break id belongs to one
 * project's database, and project databases may live on hosts whose clocks
 * disagree — advancing one shared cursor to "newest entry seen anywhere"
 * would silently drop entries from projects whose clock runs behind. So a
 * cross-project stream keeps one plain cursor per project and round-trips
 * the whole map as this envelope: `"2:" + base64url(deflate-raw(JSON))`
 * where the JSON payload is `{ "<slug>": "<plain cursor>" | null, … }`.
 *
 * Only the server mints and parses envelopes; CLI and web pass them
 * through opaquely. `null` marks a project whose stream was empty when the
 * envelope was minted ("drain from the beginning") — distinct from a slug
 * that is absent entirely, which means the caller never watched that
 * project and the server starts it at "now".
 *
 * The version rides in the prefix, over a number space shared with the
 * plain cursors themselves — 1 (implicit, unprefixed base64url JSON),
 * 2 (this envelope), 3 (compact timeline position), 4 (compact issue-list
 * position). `:` cannot appear in an unprefixed cursor (base64url
 * alphabet), so the prefix alone discriminates — no trial decoding — and a
 * version from neither list fails loudly instead of being misread. The
 * payload is compressed because it is highly
 * repetitive (slugs plus same-era cursors) and rides in GET query
 * strings, where an uncompressed envelope would grow linearly with the
 * project count; deflate-raw comes from the web-standard
 * CompressionStream global (Node ≥ 21.2, all modern browsers), keeping
 * this module free of `node:` imports so web bundles stay clean. The
 * base64url step still uses the Buffer global: the only runtime that
 * executes this code today is Node (server); a browser consumer would
 * need a small base64url helper first.
 */
const ENVELOPE_VERSION = 2;
const ENVELOPE_PREFIX = `${ENVELOPE_VERSION}:`;
const VERSION_PREFIX = /^(\d+):/;
/** Prefixed versions that are plain cursors — the caller's to decode. */
const PLAIN_VERSIONS = new Set(["3", "4"]);

/** Per-project plain cursors; null = drain that project from the beginning. */
export const MultiCursorPositions = z.record(ProjectSlug, Cursor.nullable());
export type MultiCursorPositions = z.infer<typeof MultiCursorPositions>;

/** `--since`/`after` carried a version prefix this build does not know. */
export class UnsupportedCursorVersionError extends Error {}

/** A versioned envelope whose payload does not decode or validate. */
export class MalformedMultiCursorError extends Error {}

async function through(
  bytes: Uint8Array<ArrayBuffer>,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  // Drain and write concurrently — a transform whose readable is not being
  // consumed backpressures the write — and settle both through one
  // Promise.all so a corrupt stream rejects the call without leaving the
  // other half as an unhandled rejection.
  const [out] = await Promise.all([
    new Response(transform.readable).arrayBuffer(),
    writer.write(bytes).then(() => writer.close()),
  ]);
  return new Uint8Array(out);
}

export async function encodeMultiCursor(
  positions: MultiCursorPositions,
): Promise<string> {
  // Slugs are written in sorted order so one set of positions has exactly
  // one encoding — callers may compare envelopes byte-for-byte.
  const sorted: MultiCursorPositions = {};
  for (const slug of Object.keys(positions).sort()) {
    sorted[slug] = positions[slug] ?? null;
  }
  const deflated = await through(
    new TextEncoder().encode(JSON.stringify(sorted)),
    new CompressionStream("deflate-raw"),
  );
  return ENVELOPE_PREFIX + Buffer.from(deflated).toString("base64url");
}

/**
 * The per-project positions when `raw` is an envelope, null when it is a
 * plain cursor — the caller's business — whether unprefixed or carrying a
 * plain-cursor version. Throws UnsupportedCursorVersionError on a foreign
 * version prefix and MalformedMultiCursorError when a version-2 payload
 * fails to inflate, parse, or validate.
 */
export async function decodeMultiCursor(
  raw: string,
): Promise<MultiCursorPositions | null> {
  const version = VERSION_PREFIX.exec(raw);
  if (!version) return null;
  if (PLAIN_VERSIONS.has(version[1])) return null;
  if (version[1] !== String(ENVELOPE_VERSION)) {
    throw new UnsupportedCursorVersionError(
      `unsupported cursor version "${version[1]}" (this build knows version ${ENVELOPE_VERSION})`,
    );
  }
  let payload: unknown;
  try {
    const inflated = await through(
      // Buffer's base64url decoder is lenient (foreign characters are
      // dropped, not rejected), so corruption surfaces as an inflate or
      // JSON error below rather than here.
      Buffer.from(raw.slice(version[0].length), "base64url"),
      new DecompressionStream("deflate-raw"),
    );
    payload = JSON.parse(new TextDecoder().decode(inflated));
  } catch {
    throw new MalformedMultiCursorError("malformed multi-project cursor");
  }
  const parsed = MultiCursorPositions.safeParse(payload);
  if (!parsed.success) {
    throw new MalformedMultiCursorError(
      "malformed multi-project cursor payload",
    );
  }
  return parsed.data;
}
