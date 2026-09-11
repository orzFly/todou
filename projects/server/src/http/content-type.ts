/**
 * The `content-type` an attachment route answers with, normalised from the
 * stored value.
 *
 * The output is rebuilt from validated pieces rather than spliced from the
 * input, which is what makes a hostile stored value harmless instead of merely
 * unlikely: `Headers.set` throws on a value carrying CRLF or any code point
 * above U+00FF, and that TypeError fell through to the generic error handler,
 * turning every streamed response for such a row into a permanent 500 — the
 * same shape as T-147's filename bug. Nothing here ever returns the stored
 * string, only a base type from the tables below plus a matched parameter.
 *
 * The tables are kept as data rather than a chain of `if`s, so adding a type
 * later is one line in one place.
 */

/** RFC 9110 token grammar, `type/subtype` only. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** The charset values we are willing to echo back into a header. */
const CHARSET_VALUE = /^[a-z0-9._-]+$/;

const OCTET_STREAM = "application/octet-stream";
const TEXT_PLAIN = "text/plain";

/**
 * Kept on both routes, alongside `image/*`, `audio/*` and `video/*`, which are
 * matched by prefix — a tab renders them from the bytes, which is why
 * `![](…/download/name.png)` keeps working. `nosniff` gates only `script` and
 * `style` destinations, so no image is affected by it.
 */
const KEPT_TYPES: Record<string, true> = {
  "application/pdf": true,
};

/**
 * Kept on `/view` because the CSP sandbox on that route is what makes them
 * safe, and downgraded to `text/plain` on `/download`, where nothing renders
 * them: a `script` destination ignores `content-disposition` entirely.
 *
 * This is the same set the web treats as tab-openable, which is not a
 * coincidence to preserve by accident — the attachment list points a link at
 * `/view` exactly when it expects a tab to render it.
 */
const VIEWABLE_TYPES: Record<string, true> = {
  "text/html": true,
  "application/xhtml+xml": true,
  "application/json": true,
  "application/xml": true,
  "text/xml": true,
};

/** Source-like `application/*` types; nothing wants them rendered as such. */
const TEXT_LIKE_APPLICATION: Record<string, true> = {
  "application/javascript": true,
  "application/x-javascript": true,
  "application/typescript": true,
  "application/ld+json": true,
  "application/x-ndjson": true,
  "application/yaml": true,
  "application/x-yaml": true,
  "application/toml": true,
  "application/sql": true,
  "application/x-sh": true,
};

/**
 * The type to serve `stored` as, for the variant the route asked for.
 *
 * `text/javascript` and `text/css` are `text/*` and so fall out of the general
 * rule as `text/plain` on both routes, rather than being special-cased.
 */
export function servedContentType(
  stored: string,
  variant: "download" | "view",
): string {
  const [rawBase, ...parameters] = stored.split(";");
  const base = rawBase.trim().toLowerCase();
  if (!MEDIA_TYPE.test(base)) {
    return OCTET_STREAM;
  }

  const type = mappedType(base, variant);
  // `text/plain` with no charset is decoded against a locale default rather
  // than UTF-8, which is what turns an attached Chinese log into mojibake in a
  // browser tab. Every text file this deployment produces is UTF-8.
  const charset =
    findCharset(parameters) ?? (type === TEXT_PLAIN ? "utf-8" : null);
  return charset === null ? type : `${type}; charset=${charset}`;
}

function mappedType(base: string, variant: "download" | "view"): string {
  if (
    base.startsWith("image/") ||
    base.startsWith("audio/") ||
    base.startsWith("video/") ||
    KEPT_TYPES[base]
  ) {
    return base;
  }
  if (VIEWABLE_TYPES[base]) {
    return variant === "view" ? base : TEXT_PLAIN;
  }
  if (base.startsWith("text/") || TEXT_LIKE_APPLICATION[base]) {
    return TEXT_PLAIN;
  }
  return OCTET_STREAM;
}

/**
 * The charset parameter carried through, or null. The name matches
 * case-insensitively and the value is lowercased; every other parameter is
 * dropped, as is a charset that does not look like one.
 */
function findCharset(parameters: string[]): string | null {
  for (const parameter of parameters) {
    const at = parameter.indexOf("=");
    if (at === -1) {
      continue;
    }
    if (parameter.slice(0, at).trim().toLowerCase() !== "charset") {
      continue;
    }
    const candidate = parameter
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (CHARSET_VALUE.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
