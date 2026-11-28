/**
 * The search query grammar all three ends share, as a schema `@orz/query`
 * reads. The server parses `q` and executes it (authoritative); the web box
 * parses the same string to colour it and to place completions; the CLI
 * parses it to re-quote the values that carry spaces. One string and one
 * schema carry the whole query, so "the same query gives the same results in
 * the CLI and on the web" holds structurally instead of being a discipline
 * two implementations have to keep.
 *
 * Nothing here decides whether a value exists: `label:kind:bug` parses the
 * same in a project that has that label and in one that does not. Names are
 * resolved against a project by the caller, which keeps this module a pure
 * function on either side of the wire — the same split `references-grammar.ts`
 * makes.
 */

import {
  canonicalValue,
  defineQuerySchema,
  type QueryFilter,
} from "@orz/query";
import type { SearchDomain } from "./schemas/search.ts";

/** `is:`'s canonical values, in the order help text lists them. */
export const SEARCH_IS_VALUES = ["body", "comment", "spec"] as const;
export const SEARCH_STATE_VALUES = ["open", "closed"] as const;

/**
 * More qualifier expressions than this in one `q` are rejected rather than
 * cut, the way too many terms already are.
 */
export const SEARCH_MAX_FILTERS = 16;

/**
 * todou's search syntax, read by `@orz/query` the same way on all three ends.
 * Plain escapes and no brace expansion: that is the grammar every shared link,
 * stored history entry and `todou search` script was written in, and either
 * switch would change what some of them mean (`don't` would open a quote,
 * `label:{a,b}` would become an OR).
 */
export const SEARCH_SCHEMA = defineQuerySchema({
  qualifiers: {
    is: {
      value: {
        kind: "enum",
        values: SEARCH_IS_VALUES,
        // The plural spellings are what `--in` and `?in=` already use, and a
        // reader who learned the syntax from one of those must not be told
        // their spelling is wrong here.
        aliases: {
          issue: "body",
          issues: "body",
          comments: "comment",
          specs: "spec",
        },
      },
      hint: "body, comment or spec",
    },
    state: {
      value: { kind: "enum", values: SEARCH_STATE_VALUES },
      hint: "open or closed",
    },
    status: {
      value: { kind: "named", source: "status" },
      hint: "a status name",
    },
    label: { value: { kind: "named", source: "label" }, hint: "a label name" },
    assignee: {
      value: { kind: "named", source: "member", special: ["@me"] },
      hint: "a login, or @me",
    },
    // `source` only feeds completion: a `free` value is never checked.
    harness: {
      value: { kind: "free", source: "harness", special: ["none"] },
      hint: "which agent wrote it",
    },
    session: {
      value: { kind: "free", source: "session" },
      hint: "which session wrote it",
    },
    /**
     * `metadata:<ns>[/<key>[=<value>]]` (T-282). Unlike `harness:` and
     * `session:` it narrows the *card* rather than the matched text, so it
     * plans as an issue-level condition and `-metadata:…` means "cards
     * without this".
     */
    metadata: {
      value: { kind: "free" },
      keyAliases: ["meta"],
      hint: "ns, ns/key or ns/key=value",
    },
  },
  // Only `diagnoseQuery` reads this; the server refuses the query itself.
  maxFilters: SEARCH_MAX_FILTERS,
});

export type SearchQualifier = (typeof SEARCH_SCHEMA.keys)[number];

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
export function searchIsDomains(
  filters: readonly QueryFilter<SearchQualifier>[],
): {
  domains: SearchDomain[] | null;
  unknown: string[];
} {
  let domains: SearchDomain[] | null = null;
  const unknown: string[] = [];
  for (const filter of filters) {
    if (filter.key !== "is" || filter.values.length === 0) continue;
    const named = new Set<SearchDomain>();
    for (const value of filter.values) {
      const canonical = canonicalValue(
        SEARCH_SCHEMA.qualifiers.is.value,
        value,
      );
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
