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

export const SearchPage = z.object({
  items: z.array(SearchItem),
  /**
   * Whether another page exists at this offset — not a total. Each branch
   * only ever fetches a bounded candidate set, so counting every match would
   * mean running the scan a second time with no limit to answer a question
   * nobody paginates by.
   */
  has_more: z.boolean(),
});
export type SearchPage = z.infer<typeof SearchPage>;

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
