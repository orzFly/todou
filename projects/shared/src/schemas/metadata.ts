import { z } from "zod";
import { Timestamp } from "./common.ts";
import { UserRef } from "./user.ts";

/**
 * Machine-written state hung off an issue (T-282), shaped like k8s
 * annotations: partitioned by namespace, opaque to the server, no history,
 * written silently, returned only when asked for.
 *
 * Two load-bearing properties, referenced from several places that would
 * become wrong if either changed:
 *
 * 1. The server never parses a value. Search can therefore compare a value
 *    for equality but never match inside it, and anything structured is the
 *    writer's own JSON text.
 * 2. Read permission has one level — whoever can see the project can read
 *    all of its metadata. That is what lets the change feed carry the value
 *    itself and lets a search condition be pushed down into SQL.
 */

/**
 * Namespace and key share one character set: lowercase, alphanumeric at both
 * ends, `.`, `-` and `_` in between. Same shape as a k8s label name minus the
 * `prefix/` part, because the namespace is already its own field and a second
 * separator inside a key would mean two partition syntaxes at once.
 *
 * Case is rejected rather than folded. Two keys differing only in case are
 * the attachment-name collision of T-269 again, and a program that picks its
 * own keys is better served by an error on the first write than by a silent
 * merge.
 */
export const MetadataNamespace = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/);
export type MetadataNamespace = z.infer<typeof MetadataNamespace>;

export const MetadataKey = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9._-]{0,126}[a-z0-9])?$/);
export type MetadataKey = z.infer<typeof MetadataKey>;

export const METADATA_VALUE_MAX_BYTES = 4096;
export const METADATA_NAMESPACES_PER_ISSUE = 8;
export const METADATA_KEYS_PER_NAMESPACE = 32;
export const METADATA_ENTRIES_PER_WRITE = 64;
/** Namespaces one request may name; also caps the `IN (…)` of a bundled read. */
export const METADATA_NAMESPACES_PER_QUERY = 16;

/**
 * Limited by UTF-8 byte count rather than character count: a CJK character
 * takes three bytes, so a character limit would let the real ceiling drift by
 * a factor of three depending on what was written.
 */
export const MetadataValue = z
  .string()
  .refine(
    (s) => new TextEncoder().encode(s).length <= METADATA_VALUE_MAX_BYTES,
    {
      error: `value must be at most ${METADATA_VALUE_MAX_BYTES} bytes of UTF-8`,
    },
  );
export type MetadataValue = z.infer<typeof MetadataValue>;

/**
 * `updated_at` / `updated_by` are where the current value came from, not a
 * version: overwriting one loses the previous writer along with the previous
 * value. A bare value with no provenance is close to unusable on the web
 * page, and the first question when two orchestrators fight over a key is who
 * wrote it — including when the writer was a person editing in the browser.
 */
export const IssueMetadataEntry = z.object({
  namespace: MetadataNamespace,
  key: MetadataKey,
  value: z.string(),
  updated_at: Timestamp,
  updated_by: UserRef,
});
export type IssueMetadataEntry = z.infer<typeof IssueMetadataEntry>;

export const MetadataNamespaceSummary = z.object({
  namespace: MetadataNamespace,
  keys: z.number().int().nonnegative(),
  /** The newest `updated_at` in the group. */
  updated_at: Timestamp,
});
export type MetadataNamespaceSummary = z.infer<typeof MetadataNamespaceSummary>;

/**
 * Which namespaces a request wants: a comma-separated list, or `*` for all of
 * them. `*` is not in the namespace character set, so the two readings never
 * collide. The split-then-pipe shape is the one `IssueListQuery` already uses
 * for its comma-separated id lists.
 */
export const MetadataNamespaceSelector = z
  .string()
  .transform((s) => (s === "*" ? ("*" as const) : s.split(",")))
  .pipe(
    z.union([
      z.literal("*"),
      z.array(MetadataNamespace).min(1).max(METADATA_NAMESPACES_PER_QUERY),
    ]),
  );
export type MetadataNamespaceSelector = z.infer<
  typeof MetadataNamespaceSelector
>;

/**
 * `namespace` is required. Sending no namespace at all is a typo rather than
 * a request for nothing, so it answers 400 instead of an empty list.
 */
export const IssueMetadataQuery = z.object({
  namespace: MetadataNamespaceSelector,
});
export type IssueMetadataQuery = z.infer<typeof IssueMetadataQuery>;

/** Sorted by `(namespace, key)`. The order is part of the contract: the web
 * table groups by namespace straight off this array without sorting again. */
export const IssueMetadataList = z.object({
  entries: z.array(IssueMetadataEntry),
});
export type IssueMetadataList = z.infer<typeof IssueMetadataList>;

export const IssueMetadataNamespaceList = z.object({
  namespaces: z.array(MetadataNamespaceSummary),
});
export type IssueMetadataNamespaceList = z.infer<
  typeof IssueMetadataNamespaceList
>;

export const IssueMetadataWriteEntry = z.object({
  namespace: MetadataNamespace,
  key: MetadataKey,
  /** null deletes the key. The empty string is a legal value, and storing it
   * is a different act from deleting. */
  value: MetadataValue.nullable(),
  /**
   * Compare-and-set with three states, which is why it is
   * `.optional().nullable()` and why absent must stay tellable apart from
   * null:
   *
   *   absent — write unconditionally
   *   null   — expect the key to be absent right now
   *   string — expect the current value to be exactly this
   *
   * Any expectation that does not hold fails the whole request; none of its
   * entries are stored.
   */
  if_match: z.string().nullable().optional(),
});
export type IssueMetadataWriteEntry = z.infer<typeof IssueMetadataWriteEntry>;

export const IssueMetadataWriteInput = z
  .object({
    entries: z
      .array(IssueMetadataWriteEntry)
      .min(1)
      .max(METADATA_ENTRIES_PER_WRITE),
  })
  // Naming one key twice has no reading the caller could have meant: the two
  // entries may carry different values and different expectations, and either
  // order of applying them is as defensible as the other.
  .refine(
    (input) =>
      new Set(input.entries.map((e) => `${e.namespace}/${e.key}`)).size ===
      input.entries.length,
    { error: "each (namespace, key) may appear at most once per request" },
  );
export type IssueMetadataWriteInput = z.infer<typeof IssueMetadataWriteInput>;

/** One failed `if_match`, with the value that was actually stored, so the
 * caller can retry without a second GET. */
export const MetadataPrecondition = z.object({
  namespace: MetadataNamespace,
  key: MetadataKey,
  current: z.string().nullable(),
});
export type MetadataPrecondition = z.infer<typeof MetadataPrecondition>;
