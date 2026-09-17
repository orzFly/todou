import { z } from "zod";
import { Cursor, Id, Timestamp } from "./common.ts";
import { IssueMetadataEntry, MetadataNamespaceSelector } from "./metadata.ts";
import { MuteReason } from "./mute.ts";
import { Label, ProjectSlug, Status, StatusCategory } from "./project.ts";
import { UserRef } from "./user.ts";

/** One arrival: from `at` onwards the card belongs to the next project. */
export const IssueMove = z.object({
  at: Timestamp,
  from_project_id: Id.nullable(),
  from_project: ProjectSlug.nullable(),
  from_number: Id.nullable(),
});
export type IssueMove = z.infer<typeof IssueMove>;

/**
 * One end of a block edge, as this viewer may see it (T-377).
 *
 * A viewer who cannot read the project at the other end keeps the fact and
 * loses the name: `hidden` goes true and the four naming fields go null. The
 * precedent is `IssueMove`, not the reference events — being blocked is a
 * structural fact about *this* card, so hiding the whole edge would show it
 * as free to work on while it is not.
 */
export const BlockRef = z.object({
  edge_id: Id,
  project_id: Id.nullable(),
  project: ProjectSlug.nullable(),
  number: Id.nullable(),
  /** Spelled the way that project spells its refs: "T-373" or "#373". */
  ref: z.string().nullable(),
  hidden: z.boolean(),
  /** When the blocker crossed the clear line; null = still blocking. */
  cleared_at: Timestamp.nullable(),
  /**
   * The blocker is in the trash. Still blocking — but it cannot clear itself
   * while it is in there, which is the part no other field on screen says.
   */
  blocker_deleted: z.boolean().default(false),
});
export type BlockRef = z.infer<typeof BlockRef>;

/**
 * Body of the two block POSTs (T-377). One field, and it takes any spelling
 * the deployment resolves — `#31`, `T-31`, `acme#31`, a stored
 * `/projects/7/issues/31` — because the caller pastes what it was given.
 */
export const BlockCreateInput = z.strictObject({
  ref: z.string().min(1).max(200),
});
export type BlockCreateInput = z.infer<typeof BlockCreateInput>;

export const Issue = z.object({
  id: Id,
  number: Id,
  title: z.string(),
  body: z.string(),
  status: Status,
  author: UserRef,
  assignees: z.array(UserRef),
  labels: z.array(Label),
  created_at: Timestamp,
  /**
   * Last activity on the card: edits to its own fields, plus comments,
   * attachments, answered questions and spec push/review. Being referenced
   * by another issue does not count.
   */
  updated_at: Timestamp,
  /** Last body-changing edit; null when the body was never edited. */
  body_edited_at: Timestamp.nullable(),
  /**
   * Unanswered questions across all question comments (T-19, feeds T-46).
   * Defaults on parse so clients tolerate servers predating T-19.
   */
  open_questions: z.number().int().nonnegative().default(0),
  /**
   * Denormalized spec state (T-23): current version, verdict of the current
   * version's review, unresolved anchored comments. Null version/status =
   * no spec. Defaults keep old servers parseable.
   */
  spec_version: z.number().int().positive().nullable().default(null),
  spec_review_status: z
    .enum(["unreviewed", "approved", "changes_requested"])
    .nullable()
    .default(null),
  spec_unresolved_comments: z.number().int().nonnegative().default(0),
  /**
   * Per-viewer: whether this issue has activity by someone other than the
   * requesting user, newer than their last-seen position (T-46). Computed
   * only for list responses; every other path returns the default false.
   * Defaults on parse so clients tolerate older servers.
   */
  unread: z.boolean().default(false),
  /**
   * Per-viewer: comments (any component kind) by someone other than the
   * requesting user, newer than their last-seen position (T-77; same
   * threshold as `unread`). Events don't count. The issue itself counts as
   * the first comment when someone else opened it past that position
   * (T-151) — the top post is a post — so a card nobody has replied to yet
   * still reports 1. Exact value — display capping is the client's
   * business. Computed only for list responses; every other path returns
   * the default 0. Defaults on parse so clients tolerate older servers.
   */
  unread_comments: z.number().int().nonnegative().default(0),
  /**
   * 此刻这张卡对该读者是否被静音，以及静音从哪来（T-372）。
   * `until_activity` 的卡一旦有了 mute 之后的新动静就报 null——它已经
   * 重新响了。与 `unread` 一样只有列表响应会算它，别的路径取默认值。
   * 有默认值，所以旧服务器的响应照样解析得动。
   */
  muted: MuteReason.nullable().default(null),
  /**
   * Trash state (T-145): when the card is in the trash, when it went in and
   * who put it there. Only ever non-null on a read path the viewer may see
   * the trash through — everywhere else a deleted card is simply absent.
   * Defaults keep older servers parseable.
   */
  deleted_at: Timestamp.nullable().default(null),
  deleted_by: UserRef.nullable().default(null),
  /**
   * Every project this card has lived in, oldest move first (T-231) — the
   * boundaries a client needs to parse each piece of its text under the
   * project that owned it at the time (`ownerAt`). A reader who cannot read
   * a source project gets that entry's `from_*` as null and keeps `at`, so
   * the intervals still line up and only their owner is unknown.
   */
  moves: z.array(IssueMove).default([]),
  /**
   * Metadata (T-282), returned only when the request named the namespaces it
   * wants with `?metadata=`. Optional rather than defaulted to `[]`, because
   * "nobody asked" and "asked, and this card has nothing under those
   * namespaces" are different answers — the same distinction `inbox_row`
   * keeps between an absent key and null.
   */
  metadata: z.array(IssueMetadataEntry).optional(),
  /**
   * The two directions of the same table (T-377): cards this one waits for,
   * and cards waiting for this one. Both come with every issue read — one
   * system-db query per page, whatever the page size — and both default to
   * `[]` so a response from a server predating them still parses.
   *
   * Sorted: still blocking before cleared, then by project and number, with
   * the hidden entries last. A client renders the array as it arrives.
   */
  blocked_by: z.array(BlockRef).default([]),
  blocks: z.array(BlockRef).default([]),
});
export type Issue = z.infer<typeof Issue>;

/** List rows exclude the (potentially huge) markdown body. */
export const IssueListItem = Issue.omit({ body: true });
export type IssueListItem = z.infer<typeof IssueListItem>;

export const IssueListPage = z.object({
  items: z.array(IssueListItem),
  next_cursor: z.string().nullable(),
});
export type IssueListPage = z.infer<typeof IssueListPage>;

export const IssueCreateInput = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(65536).default(""),
  status_id: Id.optional(),
  assignee_ids: z.array(Id).default([]),
  label_ids: z.array(Id).default([]),
});
export type IssueCreateInput = z.infer<typeof IssueCreateInput>;

export const IssueUpdateInput = z.object({
  title: z.string().min(1).max(300).optional(),
  body: z.string().max(65536).optional(),
  status_id: Id.optional(),
  assignee_ids: z.array(Id).optional(),
  label_ids: z.array(Id).optional(),
});
export type IssueUpdateInput = z.infer<typeof IssueUpdateInput>;

/** Body of PUT /issues/{n}/read — advance the caller's last-seen position. */
export const IssueReadInput = z.strictObject({
  /** Position to advance to (never regresses); omitted = server now(). */
  up_to: Timestamp.optional(),
});
export type IssueReadInput = z.infer<typeof IssueReadInput>;

const csvIds = z
  .string()
  .transform((s) => s.split(",").map((p) => Number(p)))
  .pipe(z.array(Id));

/** Query-string filters for the issue list (all values arrive as strings). */
export const IssueListQuery = z.object({
  /** Exact issue numbers — lets clients batch-resolve #N references. */
  numbers: csvIds.optional(),
  status: csvIds.optional(),
  label: csvIds.optional(),
  assignee: z.coerce.number().int().positive().optional(),
  category: StatusCategory.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["created", "updated", "number"]).default("created"),
  order: z.enum(["asc", "desc"]).default("desc"),
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /**
   * The trash view (T-145). False — the default every existing caller keeps
   * — excludes deleted cards; true returns *only* them, narrowed to what the
   * viewer may see there (admins the whole project, authors their own).
   */
  deleted: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().default(false),
  ),
  /**
   * Fetch each row's metadata under these namespaces along with the page
   * (T-282). One extra query for the whole page, so the cost does not grow
   * with `limit`; omitting it costs nothing and returns nothing.
   */
  metadata: MetadataNamespaceSelector.optional(),
  /**
   * True keeps only cards still blocked by an unresolved edge, false only
   * cards with none (T-377). Deliberately without a default, unlike
   * `deleted` above: omitting the key means "do not filter on this", and
   * only `.optional()` can say that.
   */
  blocked: z.preprocess(
    (v) => (typeof v === "string" ? v === "1" || v === "true" : v),
    z.boolean().optional(),
  ),
});
export type IssueListQuery = z.infer<typeof IssueListQuery>;

/** Category-neutral subset of the list filters, for the counts endpoint. */
export const IssueCountsQuery = IssueListQuery.pick({
  status: true,
  label: true,
  assignee: true,
  q: true,
});
export type IssueCountsQuery = z.infer<typeof IssueCountsQuery>;

/** Open/closed totals under the same filters, for the list header tabs. */
export const IssueCounts = z.object({
  open: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  /**
   * Per-status detail from the same aggregate, keyed by status id (decimal
   * string — JSON object keys). Statuses with zero matches are omitted.
   */
  by_status: z.record(z.string(), z.number().int().nonnegative()),
});
export type IssueCounts = z.infer<typeof IssueCounts>;
