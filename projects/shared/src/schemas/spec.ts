import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

// Spec documents (#23): a set of markdown files attached to an issue, where
// every `spec push` produces one whole-set version. Everything an agent can
// send is strictObject — same rationale as component.ts (#19).

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
