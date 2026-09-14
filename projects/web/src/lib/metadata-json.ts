import { MetadataKey, MetadataNamespace } from "@todou/shared";

/** One parse-time problem, at the line it was noticed on (1-based). */
export type ParseError = { line: number; message: string };

export type JsonParse =
  | { ok: true; entries: Map<string, string> }
  | { ok: false; errors: ParseError[] };

function jsonLineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/**
 * Parse the JSON tab: `{"namespace": {"key": "value"}}`, nothing deeper.
 * Shape violations are reported against the line the offending token sits
 * on, which the standard parser error position gives us for free. Ordering
 * of the result is the document's own key order — JSON round-trips preserve
 * insertion order for non-numeric keys.
 */
export function parseJsonDoc(text: string): JsonParse {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    const position = extractErrorPosition(error);
    return {
      ok: false,
      errors: [
        {
          line: position === null ? 1 : jsonLineOf(text, position),
          message: "not valid JSON",
        },
      ],
    };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return {
      ok: false,
      errors: [{ line: 1, message: "the document must be an object" }],
    };
  }
  const errors: ParseError[] = [];
  const entries = new Map<string, string>();
  // `JSON.parse` hands back no positions, so each report locates itself by
  // the offending key's first occurrence in the raw text. An occurrence can
  // also sit inside a string value, but a wrong line beats a constant line
  // 1 pointing at the document head on every multi-namespace card.
  const lineOf = (needle: string): number =>
    text.slice(0, Math.max(0, text.indexOf(needle))).split("\n").length;
  for (const [ns, members] of Object.entries(doc as Record<string, unknown>)) {
    if (!MetadataNamespace.safeParse(ns).success) {
      errors.push({
        line: lineOf(`"${ns}"`),
        message: `\`${ns}\` is not a valid namespace`,
      });
      continue;
    }
    if (
      typeof members !== "object" ||
      members === null ||
      Array.isArray(members)
    ) {
      errors.push({
        line: lineOf(`"${ns}"`),
        message: `\`${ns}\` must hold an object of keys, not ${jsonKindOf(members)}`,
      });
      continue;
    }
    for (const [key, value] of Object.entries(
      members as Record<string, unknown>,
    )) {
      if (!MetadataKey.safeParse(key).success) {
        errors.push({
          line: lineOf(`"${key}"`),
          message: `\`${key}\` is not a valid key in \`${ns}\``,
        });
        continue;
      }
      if (typeof value !== "string") {
        errors.push({
          line: lineOf(`"${key}"`),
          message: `\`${ns}/${key}\` must be a string, not ${jsonKindOf(value)}`,
        });
        continue;
      }
      entries.set(`${ns}/${key}`, value);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}

function jsonKindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * V8's JSON.parse error messages end with "at position N" (1-based offset
 * into the text). That is the best line number available without writing a
 * second parser, and "not valid JSON at line N" beats no line at all.
 */
function extractErrorPosition(error: unknown): number | null {
  const message = error instanceof Error ? error.message : "";
  const m = /position (\d+)$/.exec(message);
  if (m === null) return null;
  return Number(m[1]) - 1;
}

/**
 * Render entries as the JSON tab's text: two-space indent, namespace and key
 * order preserved from the input — the server sorts by `(ns, key)`, so this
 * is also document order. `JSON.stringify` escapes newlines inside strings,
 * which is what keeps a multi-line value a one-line JSON string.
 */
export function serializeJsonDoc(
  entries: readonly { namespace: string; key: string; value: string }[],
): string {
  const doc: Record<string, Record<string, string>> = {};
  for (const entry of entries) {
    let group = doc[entry.namespace];
    if (group === undefined) {
      group = {};
      doc[entry.namespace] = group;
    }
    group[entry.key] = entry.value;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}
