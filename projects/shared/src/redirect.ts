// A stand-in origin: only whether the value can leave it matters, and the
// browser resolves against an http(s) page, whose scheme is "special" — the
// one where `\` reads as `/`.
const PROBE = "http://todou.invalid";

/**
 * Whether a post-login return-to value stays on this site, judged the way the
 * browser will resolve it. A prefix check is not enough: `/\evil.example`
 * and `/<TAB>/evil.example` both start with one slash, and the browser's URL
 * parser turns them into `//evil.example`. Control characters are refused
 * outright — a path the app produced has them percent-encoded, and a raw CR
 * or LF has no business in a `Location` header.
 */
export function isSameSitePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    return new URL(value, PROBE).origin === PROBE;
  } catch {
    return false;
  }
}
