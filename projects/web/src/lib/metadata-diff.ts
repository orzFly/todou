import type {
  IssueMetadataEntry,
  IssueMetadataWriteEntry,
} from "@todou/shared";
import {
  METADATA_ENTRIES_PER_WRITE,
  METADATA_KEYS_PER_NAMESPACE,
  METADATA_NAMESPACES_PER_ISSUE,
  METADATA_VALUE_MAX_BYTES,
} from "@todou/shared";
import type { MetadataConflict } from "@/api/metadata.ts";
import { splitEntryId } from "@/lib/metadata-bulk.ts";

/** One parse-time problem, at the line it was noticed on (1-based); 0 means the document as a whole. */
export type ParseError = { line: number; message: string };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The three server limits the dialog enforces before sending anything: value
 * size, namespaces per card, keys per namespace. Line 0 marks these as
 * document-level rather than pointing at one line of text.
 */
export function precheck(next: Map<string, string>): ParseError[] {
  const errors: ParseError[] = [];
  const perNamespace = new Map<string, number>();
  for (const [id, value] of next) {
    const bytes = byteLength(value);
    if (bytes > METADATA_VALUE_MAX_BYTES) {
      errors.push({
        line: 0,
        message: `\`${id}\` is ${bytes} bytes — the limit is ${METADATA_VALUE_MAX_BYTES}`,
      });
    }
    const ns = id.slice(0, id.indexOf("/"));
    perNamespace.set(ns, (perNamespace.get(ns) ?? 0) + 1);
  }
  if (perNamespace.size > METADATA_NAMESPACES_PER_ISSUE) {
    errors.push({
      line: 0,
      message: `a card carries at most ${METADATA_NAMESPACES_PER_ISSUE} namespaces — this would write ${perNamespace.size}`,
    });
  }
  for (const [ns, count] of perNamespace) {
    if (count > METADATA_KEYS_PER_NAMESPACE) {
      errors.push({
        line: 0,
        message: `[${ns}] would carry ${count} keys — the limit is ${METADATA_KEYS_PER_NAMESPACE}`,
      });
    }
  }
  return errors;
}

/**
 * Compare the snapshot the editor opened with against what the text parses
 * to. Every direction of change leaves through here — edited, added, and
 * deleted keys alike — so the save path cannot forget one of them. Changed
 * and deleted entries expect the snapshot's value; additions expect absence.
 * Output is sorted by `(ns, key)`, matching the server's own order.
 */
export function diffMetadata(
  snapshot: Map<string, string>,
  next: Map<string, string>,
): IssueMetadataWriteEntry[] {
  const ids = new Set([...snapshot.keys(), ...next.keys()]);
  const entries: IssueMetadataWriteEntry[] = [];
  for (const id of ids) {
    const parts = splitEntryId(id);
    if (parts === null) continue;
    const before = snapshot.get(id);
    const after = next.get(id);
    if (after === before) continue;
    if (after === undefined) {
      // Deleted in the text: `value: null` removes the key, and the
      // expectation is the value it still carries on the server.
      entries.push({ ...parts, value: null, if_match: before ?? null });
    } else {
      entries.push({
        ...parts,
        value: after,
        if_match: before === undefined ? null : before,
      });
    }
  }
  entries.sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key),
  );
  return entries;
}

/** One rendered line of the conflict notice, ready to display. */
export type ConflictLine = {
  namespace: string;
  key: string;
  text: string;
  /** What the server said is stored now — the retry's new `if_match`. */
  current: string | null;
  /** Set when the refetched value equals `current`, naming the writer. */
  by: string | null;
};

/**
 * Pair the refused entries with what the 409 says is there now. The payload
 * only describes the present; what the user was trying to do has to come
 * from the refused entry itself (design: "冲突" table) — a change, an
 * addition, or a deletion, each against a value that may or may not exist.
 */
export function conflictLines(
  refused: IssueMetadataWriteEntry[],
  conflicts: MetadataConflict[],
  entries: IssueMetadataEntry[],
): ConflictLine[] {
  const now = new Map(
    conflicts.map((c) => [`${c.namespace}/${c.key}`, c.current]),
  );
  const lines: ConflictLine[] = [];
  for (const entry of refused) {
    const current = now.get(`${entry.namespace}/${entry.key}`);
    if (current === undefined) continue;
    let text: string;
    if (entry.value === null) {
      text =
        current === null
          ? "→ already deleted"
          : `→ changed to ${JSON.stringify(current)}`;
    } else if (entry.if_match === null) {
      text = current === null ? "→ deleted by someone else" : "→ now exists";
    } else {
      text =
        current === null
          ? "→ deleted by someone else"
          : `→ ${JSON.stringify(current)}`;
    }
    // The 409 names the value but not the writer; the refetch that follows
    // is on its way regardless, and only if it agrees with `current` is the
    // name it carries actually the name of whoever made the conflicting
    // write.
    const writer = entries.find(
      (e) => e.namespace === entry.namespace && e.key === entry.key,
    );
    lines.push({
      namespace: entry.namespace,
      key: entry.key,
      text,
      current,
      by:
        writer !== undefined && writer.value === current
          ? writer.updated_by.display_name
          : null,
    });
  }
  return lines;
}

/**
 * Parse plus the document-level precheck: the one step both the save path
 * and the tab-switch gate must agree on before letting anything through.
 * The per-write entry cap stays out — it bounds one write, not a document.
 */
export function readDocument(
  text: string,
  parse: (
    t: string,
  ) =>
    | { ok: true; entries: Map<string, string> }
    | { ok: false; errors: ParseError[] },
):
  | { ok: true; doc: Map<string, string> }
  | { ok: false; errors: ParseError[] } {
  const parsed = parse(text);
  if (!parsed.ok) return parsed;
  const limitErrors = precheck(parsed.entries);
  if (limitErrors.length > 0) return { ok: false, errors: limitErrors };
  return { ok: true, doc: parsed.entries };
}

/**
 * Fold one succeeded write back into the snapshot it was issued against.
 * A success is the server telling us exactly what it now stores, so the
 * next save's `if_match` must be read from here — not from the stale
 * snapshot, which would 409 on the second save.
 */
export function applyWrite(
  snapshot: Map<string, string>,
  written: IssueMetadataWriteEntry[],
): Map<string, string> {
  const next = new Map(snapshot);
  for (const entry of written) {
    const id = `${entry.namespace}/${entry.key}`;
    if (entry.value === null) next.delete(id);
    else next.set(id, entry.value);
  }
  return next;
}

/** Flatten a document into `(ns, key)`-ascending rows, for the serializers. */
export function docRows(
  doc: Map<string, string>,
): { namespace: string; key: string; value: string }[] {
  const rows: { namespace: string; key: string; value: string }[] = [];
  for (const [id, value] of doc) {
    const parts = splitEntryId(id);
    if (parts === null) continue;
    rows.push({ ...parts, value });
  }
  rows.sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key),
  );
  return rows;
}

export { METADATA_ENTRIES_PER_WRITE };
