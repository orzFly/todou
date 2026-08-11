// Project-tier schema. These tables live either in the system database
// (placement=shared) or in per-project databases (placement=dedicated).
// Every table keeps project_id and every query filters on it, so the same
// schema works in both placements and multiple projects may safely share
// one target database. References to users are LOGICAL ids into the system
// database — no foreign keys are possible across databases.
import type { AgentContext } from "@todou/shared";
import {
  bigint,
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

export const statuses = pgTable(
  "statuses",
  {
    id: id(),
    projectId: projectId(),
    name: text("name").notNull(),
    category: text("category", { enum: ["open", "closed"] }).notNull(),
    color: text("color").notNull().default("#6b7280"),
    position: integer("position").notNull(),
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
    // Self-reported client provenance (e.g. Claude Code session/model);
    // never authoritative — authorship stays author_id.
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
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
      ],
    }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    agentContext: jsonb("agent_context").$type<AgentContext | null>(),
    createdAt: createdAt(),
  },
  (t) => [index("issue_events_issue_created_idx").on(t.issueId, t.createdAt)],
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
