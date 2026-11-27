/**
 * A `Range: bytes=…` header resolved against a file's size (RFC 9110 §14.1).
 *
 * One range only. Media elements and PDF viewers ask for a single range at a
 * time, and several would need a `multipart/byteranges` body nothing here
 * consumes; RFC 9110 lets a server ignore `Range` and send the whole file,
 * which is what `whole` means for every request this does not serve.
 */
export type ByteRange =
  | { kind: "whole" }
  /** `end` is inclusive, as in `Content-Range`. */
  | { kind: "part"; start: number; end: number }
  | { kind: "unsatisfiable" };

const WHOLE: ByteRange = { kind: "whole" };
const FROM = /^(\d+)-(\d*)$/;
const SUFFIX = /^-(\d+)$/;

export function byteRangeOf(
  header: string | undefined,
  size: number,
): ByteRange {
  // An empty file has no byte to point at, so no range of it can be
  // expressed in a Content-Range.
  if (header === undefined || size === 0) return WHOLE;
  const equals = header.indexOf("=");
  if (equals === -1) return WHOLE;
  if (header.slice(0, equals).toLowerCase() !== "bytes") return WHOLE;
  const specs = header
    .slice(equals + 1)
    .split(",")
    .map((spec) => spec.trim());
  if (specs.length !== 1) return WHOLE;
  const spec = specs[0] ?? "";

  // Digit strings too long for a double read as huge numbers or Infinity;
  // every comparison below still comes out right, so they need no guard.
  const from = FROM.exec(spec);
  if (from) {
    const first = Number(from[1]);
    const last = from[2] === "" ? undefined : Number(from[2]);
    if (last !== undefined && last < first) return WHOLE;
    if (first >= size) return { kind: "unsatisfiable" };
    return {
      kind: "part",
      start: first,
      end: Math.min(last ?? size - 1, size - 1),
    };
  }
  const suffix = SUFFIX.exec(spec);
  if (suffix) {
    const length = Number(suffix[1]);
    if (length === 0) return { kind: "unsatisfiable" };
    return { kind: "part", start: Math.max(0, size - length), end: size - 1 };
  }
  return WHOLE;
}
