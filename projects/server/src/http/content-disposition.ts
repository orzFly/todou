/** RFC 5987 attr-char: everything else in the extended value gets %XX'd. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+.^_`|~-]/;

/**
 * A content-disposition value per RFC 6266, with the RFC 5987 extended
 * parameter when the name needs it.
 *
 * Header values are ByteStrings, so a filename carrying any code point above
 * 0xFF makes Headers.set throw — which is how one Chinese-named attachment
 * turned every download of it into a 500 (T-147). What comes back here is
 * always pure ASCII, whatever the name holds.
 */
export function contentDisposition(
  type: "attachment" | "inline",
  filename: string,
): string {
  // Substituting rather than dropping keeps the extension intact, so the
  // save-as default stays useful for clients that read no further.
  const fallback = filename.replaceAll(/["\\]|[^\x20-\x7e]/gu, "_");
  const header = `${type}; filename="${fallback}"`;
  // Only worth the second parameter when the first one lost something.
  return fallback === filename
    ? header
    : `${header}; filename*=UTF-8''${encodeExtValue(filename)}`;
}

function encodeExtValue(filename: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(filename)) {
    const char = String.fromCharCode(byte);
    out += ATTR_CHAR.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
