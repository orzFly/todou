import type { IssueMetadataEntry } from "@todou/shared";
import { MetadataKey, MetadataNamespace } from "@todou/shared";
export type ParseError = { line: number; message: string };

export type BulkParse =
  | { ok: true; entries: Map<string, string> }
  | { ok: false; errors: ParseError[] };

const HEREDOC_INTRO = /^<<([A-Za-z0-9_-]+)$/;

/**
 * The `${ns}/${key} = ${value}` line format's one free choice: the heredoc
 * end mark. It must not collide with a line of the value itself, so the mark
 * walks `EOF`, `EOF2`, `EOF3`, … until the value has no line spelled exactly
 * like it. `EOF` stays first because it is what a reader expects to see.
 */
export function pickHeredocMark(value: string): string {
  const lines = new Set(value.split("\n"));
  for (let n = 1; ; n++) {
    const mark = n === 1 ? "EOF" : `EOF${n}`;
    if (!lines.has(mark)) return mark;
  }
}

/**
 * Parse the whole Bulk tab (design: "Bulk 档的语法"). Line-oriented, comments
 * are whole lines only, the first `=` in a line separates, and a `<<MARK`
 * value reads following lines until one is exactly `MARK`. Anything invalid
 * is reported per line; when nothing is wrong the result is a map keyed by
 * `ns/key` — insertion-ordered, so the editor's text is the ordering too.
 */
export function parseBulk(text: string): BulkParse {
  const entries = new Map<string, string>();
  const firstSetAt = new Map<string, number>();
  const errors: ParseError[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = i + 1;
    if (line.trim() === "") continue;
    // The `#` must be the first character of the raw line — a `#` further in
    // belongs to the value, because values are opaque strings and there is
    // no quoting rule to hide one behind.
    if (line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) {
      errors.push({
        line: lineNo,
        message: "expected `namespace/key = value`",
      });
      continue;
    }
    const left = line.slice(0, eq).trim();
    const slash = left.indexOf("/");
    if (slash === -1) {
      errors.push({
        line: lineNo,
        message: `expected \`namespace/key\` on the left of \`=\`, got \`${left}\``,
      });
      continue;
    }
    const ns = left.slice(0, slash);
    const key = left.slice(slash + 1);
    if (!MetadataNamespace.safeParse(ns).success) {
      errors.push({
        line: lineNo,
        message: `\`${ns}\` is not a valid namespace`,
      });
      continue;
    }
    if (!MetadataKey.safeParse(key).success) {
      errors.push({ line: lineNo, message: `\`${key}\` is not a valid key` });
      continue;
    }

    const rest = line.slice(eq + 1).trim();
    let value: string;
    if (rest.startsWith("<<")) {
      const m = HEREDOC_INTRO.exec(rest);
      if (m === null) {
        errors.push({
          line: lineNo,
          message: "heredoc mark must be letters, digits, `-` or `_`",
        });
        continue;
      }
      const mark = m[1] as string;
      const body: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bodyLine = lines[j] as string;
        // Column-exact: an indented mark is content, not the end.
        if (bodyLine === mark) {
          closed = true;
          break;
        }
        body.push(bodyLine);
      }
      if (!closed) {
        errors.push({
          line: lineNo,
          message: `heredoc opened here is never closed — waiting for a line reading exactly \`${mark}\``,
        });
        // Nothing after an unterminated heredoc can be parsed anyway; stop
        // so the error list does not fill with line-expected-`=` noise.
        break;
      }
      value = body.join("\n");
      i = j;
    } else if (rest.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(rest);
        if (typeof parsed !== "string") {
          errors.push({
            line: lineNo,
            message: "a quoted value must parse as a JSON string",
          });
          continue;
        }
        value = parsed;
      } catch {
        errors.push({
          line: lineNo,
          message: 'a value starting with `"` must be valid JSON',
        });
        continue;
      }
    } else {
      value = rest;
    }

    const id = `${ns}/${key}`;
    const firstAt = firstSetAt.get(id);
    if (firstAt !== undefined) {
      errors.push({
        line: lineNo,
        message: `\`${id}\` is set again here; it was first set on line ${firstAt}`,
      });
      continue;
    }
    firstSetAt.set(id, lineNo);
    entries.set(id, value);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}

/**
 * Render the snapshot into editable text: server order, one `ns/key = value`
 * per line, groups separated by a blank line. Values that are not plainly
 * single-line go through a heredoc, whose mark is picked so the body cannot
 * end the heredoc early.
 */
export function serializeBulk(entries: IssueMetadataEntry[]): string {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentNs: string | null = null;
  for (const entry of entries) {
    if (entry.namespace !== currentNs) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentNs = entry.namespace;
    }
    current.push(
      `${entry.namespace}/${entry.key} = ${renderValue(entry.value)}`,
    );
  }
  if (current.length > 0) groups.push(current);
  return groups.map((lines) => lines.join("\n")).join("\n\n");
}

function renderValue(value: string): string {
  const plain =
    value !== "" &&
    !value.includes("\n") &&
    value.trim() === value &&
    !value.startsWith('"');
  if (plain) return value;
  const mark = pickHeredocMark(value);
  return `<<${mark}\n${value}\n${mark}`;
}

/** `ns/key` → its two halves, for building write entries out of a parse. */
export function splitEntryId(
  id: string,
): { namespace: string; key: string } | null {
  const slash = id.indexOf("/");
  if (slash === -1) return null;
  return { namespace: id.slice(0, slash), key: id.slice(slash + 1) };
}
