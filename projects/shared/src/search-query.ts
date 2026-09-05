/**
 * The search query grammar all three ends share. The server parses `q` and
 * executes it (authoritative); the web box parses the same string to colour
 * it and to place completions; the CLI parses it to re-quote the values that
 * carry spaces. One string carries the whole query, so "the same query gives
 * the same results in the CLI and on the web" holds structurally instead of
 * being a discipline two implementations have to keep.
 *
 * Nothing here decides whether a value exists: `label:kind:bug` parses the
 * same in a project that has that label and in one that does not. Names are
 * resolved against a project by the caller, which keeps this module a pure
 * function on either side of the wire — the same split `references-grammar.ts`
 * makes.
 */

import type { SearchDomain } from "./schemas/search.ts";

export type SearchQualifier =
  | "is"
  | "state"
  | "status"
  | "label"
  | "assignee"
  | "harness"
  | "session";

/**
 * How a key's values are decided:
 *
 * - `enum` — a closed set this module knows, so a wrong value is detectable
 *   here and worth a diagnostic.
 * - `named` — a name in the project (a label, a status, a member), resolved
 *   by the server against that project's rows.
 * - `free` — matched literally against what was written, with no set to
 *   check it against.
 */
export type QualifierKind = "enum" | "named" | "free";

export type QualifierSpec = {
  kind: QualifierKind;
  /** Canonical values of a closed set, in the order help text lists them. */
  values: readonly string[];
  /** Every accepted spelling, lowercase, canonical ones included. */
  aliases: Readonly<Record<string, string>>;
  /** Values meaning something of their own rather than naming a row. */
  special: readonly string[];
};

export const SEARCH_QUALIFIERS: Record<SearchQualifier, QualifierSpec> = {
  is: {
    kind: "enum",
    values: ["body", "comment", "spec"],
    // The plural spellings are what `--in` and `?in=` already use, and a
    // reader who learned the syntax from one of those must not be told their
    // spelling is wrong here.
    aliases: {
      body: "body",
      issue: "body",
      issues: "body",
      comment: "comment",
      comments: "comment",
      spec: "spec",
      specs: "spec",
    },
    special: [],
  },
  state: {
    kind: "enum",
    values: ["open", "closed"],
    aliases: { open: "open", closed: "closed" },
    special: [],
  },
  status: { kind: "named", values: [], aliases: {}, special: [] },
  label: { kind: "named", values: [], aliases: {}, special: [] },
  assignee: { kind: "named", values: [], aliases: {}, special: ["@me"] },
  harness: { kind: "free", values: [], aliases: {}, special: ["none"] },
  session: { kind: "free", values: [], aliases: {}, special: [] },
};

/** `is:` in the spelling `?in=` and `--in` use. */
export const SEARCH_IS_DOMAIN: Record<string, SearchDomain> = {
  body: "issues",
  comment: "comments",
  spec: "specs",
};

/** The `is:` spelling of a domain — the inverse of `SEARCH_IS_DOMAIN`. */
export const SEARCH_DOMAIN_IS: Record<SearchDomain, string> = {
  issues: "body",
  comments: "comment",
  specs: "spec",
};

export const SEARCH_DOMAINS: readonly SearchDomain[] = [
  "issues",
  "comments",
  "specs",
];

/**
 * More qualifier expressions than this in one `q` are rejected rather than
 * cut, the way too many terms already are.
 */
export const SEARCH_MAX_FILTERS = 16;

export type SearchValue = {
  start: number;
  end: number;
  /** The source slice, quotes included. */
  raw: string;
  /** What the value means, quotes removed. */
  value: string;
};

/**
 * A span of the query string. Offsets are UTF-16 indices into the original
 * `q`, so the colouring layer, the diagnostics and the completions all point
 * at the same characters without re-scanning — the convention
 * `SearchSnippet.ranges` already follows.
 */
export type SearchPart =
  | { kind: "space"; start: number; end: number }
  | { kind: "text"; start: number; end: number; raw: string; term: string }
  | {
      kind: "filter";
      start: number;
      end: number;
      raw: string;
      key: SearchQualifier;
      negated: boolean;
      /** The key as typed, `-` and `:` excluded. */
      keyStart: number;
      keyEnd: number;
      values: SearchValue[];
    };

export type SearchFilter = {
  key: SearchQualifier;
  negated: boolean;
  /** Unquoted and in source order; empty values never reach here. */
  values: string[];
};

const KEY_HEAD = /[A-Za-z]/;
const KEY_BODY = /[A-Za-z0-9_-]/;

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** A value: a quoted run, or one stretch of non-space, non-comma, non-quote. */
function scanValue(q: string, at: number): SearchValue {
  if (q[at] === '"') {
    const close = q.indexOf('"', at + 1);
    const inner = close === -1 ? q.length : close;
    const end = close === -1 ? q.length : close + 1;
    return {
      start: at,
      end,
      raw: q.slice(at, end),
      value: q.slice(at + 1, inner),
    };
  }
  let end = at;
  while (end < q.length) {
    const ch = q[end] as string;
    if (isSpace(ch) || ch === "," || ch === '"') break;
    end += 1;
  }
  return { start: at, end, raw: q.slice(at, end), value: q.slice(at, end) };
}

/**
 * `-?key:value-list` when `key` is one we know, null otherwise — and "null"
 * is the load-bearing half. `area:web` and `kind:bug` are real label names in
 * this very project, `https://…` and a timestamp like `12:30` are ordinary
 * things to search for, and all of them have hits today. Rejecting an
 * unrecognised key would turn queries that work now into syntax errors, so an
 * unknown key falls through to plain text. Searching a known key literally is
 * still possible by quoting the whole run: `"harness:"`.
 */
function scanFilter(q: string, at: number): SearchPart | null {
  let i = at;
  const negated = q[i] === "-";
  if (negated) i += 1;
  const keyStart = i;
  if (i >= q.length || !KEY_HEAD.test(q[i] as string)) return null;
  i += 1;
  while (i < q.length && KEY_BODY.test(q[i] as string)) i += 1;
  const keyEnd = i;
  if (q[i] !== ":") return null;
  const key = q.slice(keyStart, keyEnd).toLowerCase();
  if (!Object.hasOwn(SEARCH_QUALIFIERS, key)) return null;
  i += 1;

  const values: SearchValue[] = [];
  for (;;) {
    const value = scanValue(q, i);
    i = value.end;
    // An empty value is someone mid-typing (`label:`), not an error and not a
    // condition; the comma that may follow is still consumed so the scan
    // advances.
    if (value.value !== "") values.push(value);
    if (q[i] !== ",") break;
    i += 1;
  }

  return {
    kind: "filter",
    start: at,
    end: i,
    raw: q.slice(at, i),
    key: key as SearchQualifier,
    negated,
    keyStart,
    keyEnd,
    values,
  };
}

/**
 * `q` split into spans that tile it completely — every character of the input
 * belongs to exactly one part, which is what lets the mirror layer in the web
 * box render the string by walking this list.
 *
 * The scan is one pass with no backtracking, deciding at each position in
 * this order: whitespace, a quoted run, a known qualifier, bare text. Never
 * throws: a half-typed query is the normal case for a search box, and every
 * shape of input has a reading.
 */
export function parseSearchQuery(q: string): SearchPart[] {
  const parts: SearchPart[] = [];
  let i = 0;
  while (i < q.length) {
    const ch = q[i] as string;
    if (isSpace(ch)) {
      const start = i;
      while (i < q.length && isSpace(q[i] as string)) i += 1;
      parts.push({ kind: "space", start, end: i });
      continue;
    }
    if (ch === '"') {
      const close = q.indexOf('"', i + 1);
      const inner = close === -1 ? q.length : close;
      const end = close === -1 ? q.length : close + 1;
      // An unclosed quote runs to the end rather than failing — the user is
      // mid-typing, and there is exactly one thing they can mean.
      parts.push({
        kind: "text",
        start: i,
        end,
        raw: q.slice(i, end),
        term: q.slice(i + 1, inner),
      });
      i = end;
      continue;
    }
    const filter = scanFilter(q, i);
    if (filter) {
      parts.push(filter);
      i = filter.end;
      continue;
    }
    let end = i;
    // A quote ends a bare run: `ab"cd"` has been two terms since the first
    // version of this scanner, and queries in the wild rely on it.
    while (end < q.length && !isSpace(q[end] as string) && q[end] !== '"') {
      end += 1;
    }
    const raw = q.slice(i, end);
    parts.push({ kind: "text", start: i, end, raw, term: raw });
    i = end;
  }
  return parts;
}

/** The free-text terms, in source order; an empty `""` contributes nothing. */
export function searchTermsOf(parts: SearchPart[]): string[] {
  const terms: string[] = [];
  for (const part of parts) {
    if (part.kind === "text" && part.term !== "") terms.push(part.term);
  }
  return terms;
}

export function searchFiltersOf(parts: SearchPart[]): SearchFilter[] {
  const filters: SearchFilter[] = [];
  for (const part of parts) {
    if (part.kind !== "filter") continue;
    filters.push({
      key: part.key,
      negated: part.negated,
      values: part.values.map((v) => v.value),
    });
  }
  return filters;
}

/**
 * Which domains the `is:` expressions select, folded across all of them, and
 * the values none of them recognised.
 *
 * `domains: null` means the query said nothing about domains, which is not
 * the same as selecting none. Several expressions intersect and `-` takes the
 * complement, so `is:comment -is:spec` is comments. One implementation
 * because two ends read it: the server to execute it, the results page to
 * decide which chip looks pressed, and disagreeing would be a bug nobody
 * could see until the chips lied.
 */
export function searchIsDomains(filters: SearchFilter[]): {
  domains: SearchDomain[] | null;
  unknown: string[];
} {
  let domains: SearchDomain[] | null = null;
  const unknown: string[] = [];
  for (const filter of filters) {
    if (filter.key !== "is" || filter.values.length === 0) continue;
    const named = new Set<SearchDomain>();
    for (const value of filter.values) {
      const canonical = canonicalQualifierValue("is", value);
      if (canonical === null) {
        unknown.push(value);
        continue;
      }
      named.add(SEARCH_IS_DOMAIN[canonical] as SearchDomain);
    }
    const expressed = filter.negated
      ? SEARCH_DOMAINS.filter((d) => !named.has(d))
      : SEARCH_DOMAINS.filter((d) => named.has(d));
    domains =
      domains === null
        ? [...expressed]
        : domains.filter((d) => expressed.includes(d));
  }
  return { domains, unknown };
}

/**
 * The canonical spelling of a closed-set value, or null when the set does not
 * hold it. `named` and `free` keys answer null for everything: their values
 * are decided against a project, not here.
 */
export function canonicalQualifierValue(
  key: SearchQualifier,
  raw: string,
): string | null {
  const spec = SEARCH_QUALIFIERS[key];
  if (spec.kind !== "enum") return null;
  return spec.aliases[raw.toLowerCase()] ?? null;
}

/** Whether a value stands for itself (`@me`, `none`) rather than naming a row. */
export function isSpecialQualifierValue(
  key: SearchQualifier,
  raw: string,
): boolean {
  return SEARCH_QUALIFIERS[key].special.includes(raw.toLowerCase());
}
