// Project-tier schema. These tables live either in the system database
// (placement=shared) or in per-project databases (placement=dedicated).
// Every table keeps project_id and every query filters on it, so the same
// schema works in both placements and multiple projects may safely share
// one target database. References to users are LOGICAL ids into the system
// database — no foreign keys are possible across databases.
import type { AgentContext, CommentComponent } from "@todou/shared";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () =>
  bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey();
const projectId = () => bigint("project_id", { mode: "number" }).notNull();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const projectMeta = pgTable("project_meta", {
  projectId: bigint("project_id", { mode: "number" }).primaryKey(),
  nextIssueNumber: bigint("next_issue_number", { mode: "number" })
    .notNull()
    .default(1),
  createdAt: createdAt(),
});

// Append-only internal reference-format history (#80). NULL prefix = "#N".
// The format in force for a piece of content is the newest row with
// effective_from <= content.created_at — history, not a single value, so
// legacy text keeps parsing under the format it was written in.
export const refFormats = pgTable(
  "ref_formats",
  {
    id: id(),
    projectId: projectId(),
    prefix: text("prefix"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ref_formats_project_from_idx").on(t.projectId, t.effectiveFrom),
  ],
);

export const autolinks = pgTable(
  "autolinks",
  {
    id: id(),
    projectId: projectId(),
    prefix: text("prefix").notNull(),
    urlTemplate: text("url_template").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("autolinks_project_prefix_idx").on(t.projectId, t.prefix),
  ],
);

export const statuses = pgTable(
  "statuses",
  {
    id: id(),
    projectId: projectId(),
    name: text("name").notNull(),
    category: text("category", { enum: ["open", "closed"] }).notNull(),
    color: text("color").notNull().default("#6b7280"),
    position: integer("position").notNull(),
    // At most one default per project (enforced by updateStatus). When none
    // is set, new issues fall back to the first status by position.
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [uniqueIndex("statuses_project_name_idx").on(t.projectId, t.name)],
);

export const labels = pgTable(
  "labels",
  {
    id: id(),
    projectId: projectId(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#3b82f6"),
  },
  (t) => [uniqueIndex("labels_project_name_idx").on(t.projectId, t.name)],
);

export const issues = pgTable(
  "issues",
  {
    id: id(),
    projectId: projectId(),
    number: bigint("number", { mode: "number" }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    statusId: bigint("status_id", { mode: "number" })
      .notNull()
      .references(() => statuses.id),
    authorId: bigint("author_id", { mode: "number" }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    bodyEditedAt: timestamp("body_edited_at", { withTimezone: true }),
    // Denormalized unanswered-question count (#19). Safe against drift:
    // components are immutable and answer events append-only, so the only
    // writers are comment create (+N), first answer (-N), and the delete
    // of a still-unanswered question comment (-N).
    openQuestions: integer("open_questions").notNull().default(0),
    // Denormalized spec state (#23), same bounded-writer discipline: push
    // bumps the version and resets the status, a review writes its verdict,
    // resolve/delete of an anchored comment moves the count. NULL version
    // and status = the issue has no spec.
    specVersion: integer("spec_version"),
    specReviewStatus: text("spec_review_status", {
      enum: ["unreviewed", "approved", "changes_requested"],
    }),
    specUnresolvedComments: integer("spec_unresolved_comments")
      .notNull()
      .default(0),
  },
  (t) => [
    uniqueIndex("issues_project_number_idx").on(t.projectId, t.number),
    index("issues_project_status_idx").on(t.projectId, t.statusId),
    index("issues_project_updated_idx").on(t.projectId, t.updatedAt),
  ],
);

export const issueAssignees = pgTable(
  "issue_assignees",
  {
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.userId] })],
);

export const issueLabels = pgTable(
  "issue_labels",
  {
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: bigint("label_id", { mode: "number" })
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.issueId, t.labelId] })],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    projectId: projectId(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorId: bigint("author_id", { mode: "number" }).notNull(),
    body: text("body").notNull(),
    // Structured slot rendered after the body ({type:"questions",…}, #19).
    // Immutable once written — updateComment never touches it.
    component: jsonb("component").$type<CommentComponent | null>(),
    // Self-reported client provenance (e.g. Claude Code session/model);
    // never authoritative — authorship stays author_id.
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // Spec-comment resolution (#23). One-way: set once, never cleared —
    // meaningful only for comments whose component is a spec anchor.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: bigint("resolved_by", { mode: "number" }),
  },
  (t) => [index("comments_issue_created_idx").on(t.issueId, t.createdAt)],
);

export const issueEvents = pgTable(
  "issue_events",
  {
    id: id(),
    projectId: projectId(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    actorId: bigint("actor_id", { mode: "number" }).notNull(),
    type: text("type", {
      enum: [
        "opened",
        "closed",
        "reopened",
        "status_changed",
        "title_changed",
        "label_added",
        "label_removed",
        "assigned",
        "unassigned",
        "referenced",
        "attachment_added",
        "question_answered",
        "spec_pushed",
        "spec_review",
        "spec_comments_resolved",
      ],
    }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("issue_events_issue_created_idx").on(t.issueId, t.createdAt)],
);

// One row per content-changing edit, holding the superseded text (snapshot
// BEFORE the edit). Polymorphic over what it versions — future subjects
// (e.g. spec files) extend the enum without a migration. No FKs by
// consequence: cleanup is the owning service's job.
export const revisions = pgTable(
  "revisions",
  {
    id: id(),
    projectId: projectId(),
    subjectType: text("subject_type", {
      enum: ["issue_body", "comment"],
    }).notNull(),
    subjectId: bigint("subject_id", { mode: "number" }).notNull(),
    body: text("body").notNull(),
    // Who performed the edit that replaced this content.
    actorId: bigint("actor_id", { mode: "number" }).notNull(),
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("revisions_subject_idx").on(
      t.projectId,
      t.subjectType,
      t.subjectId,
      t.id,
    ),
  ],
);

// One row per `spec push` — the version list of an issue's spec (#23).
// Versions are whole-set snapshots: reading v(N) never replays history.
export const specVersions = pgTable(
  "spec_versions",
  {
    id: id(),
    projectId: projectId(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    // Per-issue counter (v1, v2, …). Uniqueness doubles as the concurrency
    // backstop: two pushes racing to the same number cannot both land.
    number: integer("number").notNull(),
    authorId: bigint("author_id", { mode: "number" }).notNull(),
    message: text("message"),
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("spec_versions_issue_number_idx").on(
      t.projectId,
      t.issueId,
      t.number,
    ),
  ],
);

// Full file snapshot per version; a file deleted in v(N) simply has no row
// there. Unchanged bodies repeat across versions — acceptable at markdown
// sizes (≤1MB × ≤64 files), and it keeps "file X at version N" one lookup.
export const specVersionFiles = pgTable(
  "spec_version_files",
  {
    id: id(),
    projectId: projectId(),
    versionId: bigint("version_id", { mode: "number" })
      .notNull()
      .references(() => specVersions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    body: text("body").notNull(),
    size: integer("size").notNull(),
  },
  (t) => [
    uniqueIndex("spec_version_files_version_path_idx").on(t.versionId, t.path),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    projectId: projectId(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    uploaderId: bigint("uploader_id", { mode: "number" }).notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("attachments_storage_key_idx").on(t.storageKey),
    index("attachments_issue_idx").on(t.issueId),
  ],
);

// Direct-upload bookkeeping (#3): a row is written when a presigned PUT is
// issued and marked completed when the attachment row lands. Rows are the
// ONLY inventory of maybe-orphaned objects — gc walks this table instead of
// listing the bucket, which is what keeps gc O(pending), not O(bucket).
export const pendingUploads = pgTable(
  "pending_uploads",
  {
    id: id(),
    projectId: projectId(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    uploaderId: bigint("uploader_id", { mode: "number" }).notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
    sha256: text("sha256"),
    storageKey: text("storage_key").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pending_uploads_storage_key_idx").on(t.storageKey),
    index("pending_uploads_expires_idx").on(t.expiresAt),
  ],
);

// Per-user read positions (#46). Unread is computed at read time from these
// plus the activity tables — deliberately NOT denormalized onto issues: the
// flag is per-viewer and comments are deletable, so live computation stays
// correct with no counter discipline (contrast open_questions above).
export const issueReads = pgTable(
  "issue_reads",
  {
    id: id(),
    projectId: projectId(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("issue_reads_issue_user_idx").on(t.issueId, t.userId)],
);

// A user's unread epoch in a project, created lazily on their first unread
// computation: anything older is treated as read, so enabling the feature
// (or joining a project) never lights up history — same bootstrap semantics
// as the CLI's local state (#35).
export const readFrontiers = pgTable(
  "read_frontiers",
  {
    id: id(),
    projectId: projectId(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    frontierAt: timestamp("frontier_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("read_frontiers_project_user_idx").on(t.projectId, t.userId),
  ],
);
