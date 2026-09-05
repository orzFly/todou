import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { Status } from "./project.ts";

/** Which of the three searchable domains a hit came from (T-141). */
export const SearchKind = z.enum(["issue", "comment", "spec"]);
export type SearchKind = z.infer<typeof SearchKind>;

/** The query-string spelling of a domain, plural like the CLI's `--in`. */
export const SearchDomain = z.enum(["issues", "comments", "specs"]);
export type SearchDomain = z.infer<typeof SearchDomain>;

/** Which text the snippet was cut from. */
export const SearchField = z.enum(["title", "body", "path"]);
export type SearchField = z.infer<typeof SearchField>;

/**
 * A window of the matched text plus every term hit inside it.
 *
 * `ranges` are UTF-16 offsets into `text` — `text.slice(start, end)` is the
 * matched run, no re-scan and no re-implementation of the escaping rules on
 * the client. The window itself is cut on code points so a surrogate pair is
 * never halved, but the offsets that come back are the ones JavaScript
 * indexes strings with.
 */
export const SearchSnippet = z.object({
  text: z.string(),
  ranges: z.array(z.tuple([z.number().int().nonnegative(), z.number().int()])),
});
export type SearchSnippet = z.infer<typeof SearchSnippet>;

/** The card a hit belongs to; enough to render a row without a second read. */
export const SearchIssueRef = z.object({
  number: Id,
  title: z.string(),
  status: Status,
});
export type SearchIssueRef = z.infer<typeof SearchIssueRef>;

export const SearchItem = z.object({
  kind: SearchKind,
  issue: SearchIssueRef,
  /** kind=comment: the comment carrying the hit (`#comment-<id>`). */
  comment_id: Id.nullable(),
  /** kind=spec: the file path within the issue's newest spec version. */
  spec_path: z.string().nullable(),
  field: SearchField,
  snippet: SearchSnippet,
  updated_at: Timestamp,
});
export type SearchItem = z.infer<typeof SearchItem>;

/**
 * Something wrong with a qualifier, reported instead of refused. A shared
 * link whose label was since renamed has to keep opening a results page that
 * says which word to change — turning it into an error page would leave the
 * reader with nothing to go on.
 */
export const SearchDiagnostic = z.object({
  /** error = this condition can match nothing; note = it ran, with a caveat. */
  severity: z.enum(["error", "note"]),
  /** The qualifier at fault, e.g. "label". */
  key: z.string(),
  /** The value at fault; null when the whole expression is. */
  value: z.string().nullable(),
  /** Already a sentence, so neither end assembles its own wording. */
  message: z.string(),
  /** A near miss from the same closed set, or null. */
  suggestion: z.string().nullable(),
});
export type SearchDiagnostic = z.infer<typeof SearchDiagnostic>;

export const SearchPage = z.object({
  items: z.array(SearchItem),
  /**
   * Whether another page exists at this offset — not a total. Each branch
   * only ever fetches a bounded candidate set, so counting every match would
   * mean running the scan a second time with no limit to answer a question
   * nobody paginates by.
   */
  has_more: z.boolean(),
  /**
   * Always present, empty when the query was clean — a client then never has
   * to tell "an older server" apart from "nothing to report".
   */
  diagnostics: z.array(SearchDiagnostic),
});
export type SearchPage = z.infer<typeof SearchPage>;

/**
 * The values `harness:` and `session:` can actually be given, drawn from what
 * clients have written rather than from `HARNESS_IDS` — a project whose
 * agents todou has no logo for still gets completions, and a harness nobody
 * here uses does not clutter the list.
 *
 * Only these two: `label:`, `status:` and `assignee:` already have endpoints.
 */
export const SearchFacets = z.object({
  harnesses: z.array(
    z.object({
      /** null is "no agent context", i.e. `harness:none`. */
      agent: z.string().nullable(),
      count: z.number().int().nonnegative(),
    }),
  ),
  sessions: z.array(
    z.object({
      session_id: z.string(),
      /** The agent this session last reported. */
      agent: z.string().nullable(),
      count: z.number().int().nonnegative(),
      last_seen: Timestamp,
    }),
  ),
});
export type SearchFacets = z.infer<typeof SearchFacets>;

/**
 * Hard caps, because this is a pool for a dropdown and not a report: a busy
 * project accumulates sessions without bound, and nobody scrolls a completion
 * list past its first screen.
 */
export const SEARCH_FACET_HARNESSES = 20;
export const SEARCH_FACET_SESSIONS = 50;

/** Terms above this count, or a longer `q`, are rejected rather than cut. */
export const SEARCH_MAX_QUERY_CHARS = 256;
export const SEARCH_MAX_TERMS = 8;

const csvIds = z
  .string()
  .transform((s) => s.split(",").map((p) => Number(p)))
  .pipe(z.array(Id));

export const SearchQuery = z.object({
  q: z.string().min(1).max(SEARCH_MAX_QUERY_CHARS),
  /** Comma-separated domains; absent = all three. */
  in: z
    .string()
    .transform((s) => s.split(",").map((p) => p.trim()))
    .pipe(z.array(SearchDomain).min(1))
    .optional(),
  status: csvIds.optional(),
  label: csvIds.optional(),
  assignee: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SearchQuery = z.infer<typeof SearchQuery>;
