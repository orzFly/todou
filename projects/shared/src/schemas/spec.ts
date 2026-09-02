import { z } from "zod";
import { Cursor, Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

// Spec documents (T-23): a set of markdown files attached to an issue, where
// every `spec push` produces one whole-set version. Everything an agent can
// send is strictObject — same rationale as component.ts (T-19).

export const SPEC_MAX_FILES = 64;
export const SPEC_MAX_FILE_CHARS = 1_048_576;

/**
 * Relative markdown path, forward slashes only. Each segment must be a
 * plain name: no "", ".", "..", no leading dot (hidden files), no
 * backslashes or control characters — a Windows path or a traversal
 * attempt must fail loudly, not resolve somewhere surprising.
 */
export const SpecFilePath = z
  .string()
  .min(4, "paths are relative markdown files, e.g. design.md")
  .max(300)
  .refine((p) => /\.md$/i.test(p), { error: "only .md files belong in a spec" })
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range exists to reject control characters in paths
  .refine((p) => !/[\\\u0000-\u001f]/.test(p), {
    error: "path must use forward slashes and no control characters",
  })
  .refine(
    (p) =>
      p
        .split("/")
        .every((seg) => seg !== "" && seg !== "." && !seg.startsWith(".")),
    {
      error:
        "path must be relative with plain segments (no leading /, no . or .. segments, no dotfiles)",
    },
  );
export type SpecFilePath = z.infer<typeof SpecFilePath>;

export const SpecFileInput = z.strictObject({
  path: SpecFilePath,
  body: z.string().max(SPEC_MAX_FILE_CHARS, "spec files are capped at 1MB"),
});
export type SpecFileInput = z.infer<typeof SpecFileInput>;

export const SpecPushInput = z
  .strictObject({
    files: z
      .array(SpecFileInput)
      .min(1, "a spec cannot be empty")
      .max(SPEC_MAX_FILES),
    message: z.string().min(1).max(2000).optional(),
    /** Optimistic lock: fail with 409 unless the current version matches. */
    if_version: z.number().int().positive().optional(),
  })
  .refine(
    (input) =>
      new Set(input.files.map((f) => f.path)).size === input.files.length,
    { error: "duplicate paths in push", path: ["files"] },
  );
export type SpecPushInput = z.infer<typeof SpecPushInput>;

export const SpecPushResult = z.object({
  /** True when the push matched the current version exactly — no new version. */
  unchanged: z.boolean(),
  /** The new version number, or the current one when unchanged. */
  version: z.number().int().positive(),
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
  /**
   * Where to start waiting for the verdict (T-182): every timeline entry
   * created after this push is strictly after this cursor, and the push's
   * own event is not. Taking a "now" cursor *after* the push instead is
   * the race this field removes — the review can land in between, and a
   * watch from the later cursor then waits for something already past.
   */
  cursor: Cursor,
});
export type SpecPushResult = z.infer<typeof SpecPushResult>;

export const SpecReviewStatus = z.enum([
  "unreviewed",
  "approved",
  "changes_requested",
]);
export type SpecReviewStatus = z.infer<typeof SpecReviewStatus>;

export const SpecVersionInfo = z.object({
  number: z.number().int().positive(),
  author: UserRef,
  message: z.string().nullable(),
  created_at: Timestamp,
});
export type SpecVersionInfo = z.infer<typeof SpecVersionInfo>;

export const SpecFileEntry = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
});
export type SpecFileEntry = z.infer<typeof SpecFileEntry>;

/** GET …/spec — 404 when the issue has no spec. */
export const SpecInfo = z.object({
  current_version: z.number().int().positive(),
  /**
   * Where the current version was pushed. A wait re-entered from here reads
   * everything said since that push; one starting at a "now" cursor taken
   * at re-entry drops it — a verdict survives in `review_status`, a plain
   * comment asking a question does not (T-208).
   */
  current_version_cursor: Cursor,
  review_status: SpecReviewStatus,
  unresolved_comments: z.number().int().nonnegative(),
  /** Files of the current version. */
  files: z.array(SpecFileEntry),
  /** All versions, oldest first. */
  versions: z.array(SpecVersionInfo),
});
export type SpecInfo = z.infer<typeof SpecInfo>;

export const SpecFile = z.object({
  path: z.string(),
  body: z.string(),
  size: z.number().int().nonnegative(),
});
export type SpecFile = z.infer<typeof SpecFile>;

export const SpecFiles = z.object({
  version: z.number().int().positive(),
  files: z.array(SpecFile),
});
export type SpecFiles = z.infer<typeof SpecFiles>;

export const SpecFilesQuery = z.object({
  version: z.coerce.number().int().positive().optional(),
});
export type SpecFilesQuery = z.infer<typeof SpecFilesQuery>;

/** Payload of the `spec_pushed` timeline event. */
export const SpecPushedPayload = z.strictObject({
  version: z.number().int().positive(),
  message: z.string().nullable(),
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
});
export type SpecPushedPayload = z.infer<typeof SpecPushedPayload>;

/** Payload of the `spec_review` timeline event. */
export const SpecReviewVerdict = z.enum(["approve", "request_changes"]);
export type SpecReviewVerdict = z.infer<typeof SpecReviewVerdict>;

export const SpecReviewPayload = z.strictObject({
  version: z.number().int().positive(),
  verdict: SpecReviewVerdict,
  /** The summary comment created alongside, when the reviewer wrote one. */
  comment_id: Id.nullable(),
  annotation_count: z.number().int().nonnegative(),
});
export type SpecReviewPayload = z.infer<typeof SpecReviewPayload>;

// — inline comments (annotations) —

/**
 * What a reviewer submits: where the comment hangs. Line numbers are
 * 1-based inclusive source lines; omitting BOTH makes it a file-level
 * comment (T-61) — one line without the other is rejected.
 *
 * Columns (T-142) narrow the anchor inside those lines: 1-based inclusive
 * UTF-16 code-unit offsets, `col_start` into `line_start` and `col_end`
 * into `line_end`. They are optional everywhere — an anchor without them
 * still means "these whole lines", which is what every anchor taken before
 * T-142 means and what the diff view keeps producing.
 */
export const SpecCommentAnchorInput = z
  .strictObject({
    path: SpecFilePath,
    /** The version the reviewer was looking at when anchoring. */
    version: z.number().int().positive(),
    line_start: z.number().int().positive().optional(),
    line_end: z.number().int().positive().optional(),
    col_start: z.number().int().positive().optional(),
    col_end: z.number().int().positive().optional(),
  })
  .refine((a) => (a.line_start === undefined) === (a.line_end === undefined), {
    error: "line_start and line_end come together (omit both for file-level)",
    path: ["line_end"],
  })
  .refine(
    (a) =>
      a.line_start === undefined ||
      a.line_end === undefined ||
      a.line_end >= a.line_start,
    { error: "line_end must be >= line_start", path: ["line_end"] },
  )
  .refine((a) => (a.col_start === undefined) === (a.col_end === undefined), {
    error: "col_start and col_end come together (omit both for whole lines)",
    path: ["col_end"],
  })
  .refine((a) => a.col_start === undefined || a.line_start !== undefined, {
    error: "columns need lines (a file-level anchor cannot carry columns)",
    path: ["col_start"],
  })
  .refine(
    (a) =>
      a.col_start === undefined ||
      a.col_end === undefined ||
      a.line_start !== a.line_end ||
      a.col_end >= a.col_start,
    {
      error: "col_end must be >= col_start within one line",
      path: ["col_end"],
    },
  );
export type SpecCommentAnchorInput = z.infer<typeof SpecCommentAnchorInput>;

/**
 * Stored form: the server stamps `quote` (verbatim snapshot of the anchored
 * source — the whole lines, or just the columns when the anchor carries
 * them) so timeline cards render without fetching the file, and so a client
 * cannot forge what the lines said. Null lines = file-level.
 *
 * Columns are `nullish` on the way in, not merely `nullable`: anchors stored
 * before T-142 are JSONB rows with no such key at all, and they must keep
 * parsing. The default normalizes them to an explicit null so every
 * response shape is the same regardless of when the row was written.
 */
export const SpecCommentAnchor = z.strictObject({
  path: z.string(),
  version: z.number().int().positive(),
  line_start: z.number().int().positive().nullable(),
  line_end: z.number().int().positive().nullable(),
  col_start: z.number().int().positive().nullish().default(null),
  col_end: z.number().int().positive().nullish().default(null),
  quote: z.string(),
});
export type SpecCommentAnchor = z.infer<typeof SpecCommentAnchor>;

/** The positional half of an anchor, however it reached the reader. */
export type AnchorRangeLike = {
  line_start?: number | null;
  line_end?: number | null;
  col_start?: number | null;
  col_end?: number | null;
};

/**
 * Human label for where an anchor points: `file`, `L5`, `L5–7`, `L5:12–34`,
 * `L5:12–L7:34`. Shared so the four web surfaces that show an anchor agree
 * on the spelling down to the dash.
 */
export function formatAnchorRange(anchor: AnchorRangeLike): string {
  const { line_start: lineStart, line_end: lineEnd } = anchor;
  if (lineStart === null || lineStart === undefined) return "file";
  const end = lineEnd ?? lineStart;
  const colStart = anchor.col_start ?? null;
  const colEnd = anchor.col_end ?? null;
  if (colStart === null || colEnd === null) {
    return end === lineStart ? `L${lineStart}` : `L${lineStart}–${end}`;
  }
  return end === lineStart
    ? `L${lineStart}:${colStart}–${colEnd}`
    : `L${lineStart}:${colStart}–L${end}:${colEnd}`;
}

/**
 * Comment-component member for spec annotations. Never client-creatable
 * (CommentComponentInput deliberately excludes it): rows are born only
 * inside a review submission, where the anchor is validated against the
 * stored version.
 */
export const SpecCommentComponent = z.strictObject({
  type: z.literal("spec_comment"),
  anchor: SpecCommentAnchor,
});
export type SpecCommentComponent = z.infer<typeof SpecCommentComponent>;

// — review submission —

export const SpecReviewCommentInput = z.strictObject({
  anchor: SpecCommentAnchorInput,
  /** Markdown. */
  body: z.string().min(1).max(65536),
});
export type SpecReviewCommentInput = z.infer<typeof SpecReviewCommentInput>;

/**
 * One atomic review: verdict + optional summary + every staged inline
 * comment. `version` must equal the current version — reviewing yesterday's
 * spec conflicts instead of silently signing off the wrong thing.
 */
export const SpecReviewSubmitInput = z.strictObject({
  version: z.number().int().positive(),
  verdict: SpecReviewVerdict,
  /** Markdown; becomes a regular summary comment when non-empty. */
  body: z.string().min(1).max(65536).optional(),
  comments: z.array(SpecReviewCommentInput).max(100).default([]),
});
export type SpecReviewSubmitInput = z.infer<typeof SpecReviewSubmitInput>;

export const SpecReviewResult = z.object({
  event_id: Id,
  version: z.number().int().positive(),
  verdict: SpecReviewVerdict,
  summary_comment_id: Id.nullable(),
  comment_ids: z.array(Id),
});
export type SpecReviewResult = z.infer<typeof SpecReviewResult>;

// — resolve —

export const SpecCommentsResolveInput = z.strictObject({
  comment_ids: z.array(Id).min(1).max(100),
});
export type SpecCommentsResolveInput = z.infer<typeof SpecCommentsResolveInput>;

/** Payload of the `spec_comments_resolved` timeline event. */
export const SpecCommentsResolvedPayload = z.strictObject({
  comment_ids: z.array(Id),
  paths: z.array(z.string()),
});
export type SpecCommentsResolvedPayload = z.infer<
  typeof SpecCommentsResolvedPayload
>;

// — structured listing (GET …/spec/comments, `todou spec comments`) —

export const SpecCommentItem = z.object({
  comment_id: Id,
  author: UserRef,
  created_at: Timestamp,
  /** Markdown body of the comment. */
  body: z.string(),
  anchor: SpecCommentAnchor,
  resolved: z.object({ by: UserRef, at: Timestamp }).nullable(),
  /**
   * True when the anchored lines were touched (or the file removed) between
   * the anchored version and the current one — the comment refers to text
   * that no longer reads the same.
   */
  outdated: z.boolean(),
  /** Anchor remapped onto the current version; null when outdated. */
  current_line_start: z.number().int().positive().nullable(),
  current_line_end: z.number().int().positive().nullable(),
});
export type SpecCommentItem = z.infer<typeof SpecCommentItem>;

export const SpecComments = z.object({
  current_version: z.number().int().positive(),
  items: z.array(SpecCommentItem),
});
export type SpecComments = z.infer<typeof SpecComments>;
