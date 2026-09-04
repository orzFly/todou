import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () =>
  bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: id(),
    kind: text("kind", { enum: ["human", "machine"] }).notNull(),
    login: text("login").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    // Required for machine users: the owning human who manages the agent.
    ownerId: bigint("owner_id", { mode: "number" }).references(
      (): AnyPgColumn => users.id,
    ),
    oidcSubject: text("oidc_subject"),
    // Storage key of the uploaded avatar blob; null = initials fallback.
    // A fresh key per upload doubles as the cache-busting version.
    avatarKey: text("avatar_key"),
    avatarContentType: text("avatar_content_type"),
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    // Soft deactivation (used for agents): blocks all authentication.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_login_idx").on(t.login),
    // The subject is the sole identity key for oidc/forward provisioning;
    // uniqueness is what makes "insert, let the index arbitrate" races safe.
    // Postgres treats NULLs as distinct, so PAT-only machine rows never clash.
    uniqueIndex("users_oidc_subject_idx").on(t.oidcSubject),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("sessions_token_hash_idx").on(t.tokenHash)],
);

export const tokens = pgTable(
  "tokens",
  {
    id: id(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("tokens_token_hash_idx").on(t.tokenHash),
    index("tokens_user_id_idx").on(t.userId),
  ],
);

// A CLI login waiting for someone to authorize it in a browser (T-140).
// Rows are short-lived: they expire after 15 minutes, and poll deletes the
// row the instant it hands the outcome over. Nothing secret is stored — the
// poll secret only as a hash, and the PAT is minted at pickup, never here.
export const cliAuthRequests = pgTable(
  "cli_auth_requests",
  {
    id: id(),
    // Normalized form (no dashes, uppercase); the dashed form is display only.
    code: text("code").notNull(),
    pollSecretHash: text("poll_secret_hash").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["pending", "approved", "denied"] })
      .notNull()
      .default("pending"),
    // Whose token this becomes, resolved at approval time.
    approvedUserId: bigint("approved_user_id", { mode: "number" }).references(
      () => users.id,
    ),
    approvedById: bigint("approved_by_id", { mode: "number" }).references(
      () => users.id,
    ),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("cli_auth_requests_code_idx").on(t.code)],
);

export const userPrefs = pgTable("user_prefs", {
  userId: bigint("user_id", { mode: "number" })
    .primaryKey()
    .references(() => users.id),
  // One jsonb blob, validated by the MePrefs schema at the service layer:
  // adding a preference key must not need a migration.
  prefs: jsonb("prefs").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // Per-project routing override; null = follow configured placement.
    databaseUrl: text("database_url"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("projects_slug_idx").on(t.slug)],
);

// Mirror of every project's ref_formats history (T-150). Resolving a bare
// `PREFIX-N` written in project A means asking who held that prefix at that
// instant across ALL projects — a question the per-project tables cannot
// answer without opening every database in the deployment.
export const refPrefixes = pgTable(
  "ref_prefixes",
  {
    id: id(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // NULL = "#N", and the row still matters: it closes the previous
    // prefix's holding interval.
    prefix: text("prefix"),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
  },
  (t) => [
    index("ref_prefixes_project_from_idx").on(t.projectId, t.effectiveFrom),
    index("ref_prefixes_prefix_idx").on(t.prefix),
  ],
);

// Who held which slug, when (T-156). Same append-only shape as ref_prefixes
// above, and read the same way: a row's holding interval runs to the same
// project's next row. Unlike ref_prefixes this is not a mirror — it lives
// beside the projects it describes and is written in the same transaction,
// so there is no repair pass to run at boot.
export const slugHistory = pgTable(
  "slug_history",
  {
    id: id(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("slug_history_slug_from_idx").on(t.slug, t.effectiveFrom),
    index("slug_history_project_from_idx").on(t.projectId, t.effectiveFrom),
  ],
);

// Where a card that moved between projects lives now (T-231): one row per
// (project, number) it has ever occupied, all of them pointing at the same
// current address. Flattened rather than chained, so resolving an old
// address is one lookup however many times the card has moved.
//
// System tier because "where did A/123 go" has to be answerable from a
// third project's database — the same argument ref_prefixes makes above.
// project_id and current_project_id are LOGICAL ids: the rows they name may
// live in another database, so no foreign key is possible.
export const issueAddresses = pgTable(
  "issue_addresses",
  {
    id: id(),
    // The card's identity across every move, taken from the id of the first
    // row inserted for it — stable even though (project, number) is not.
    lineage: bigint("lineage", { mode: "number" }).notNull(),
    projectId: bigint("project_id", { mode: "number" }).notNull(),
    number: bigint("number", { mode: "number" }).notNull(),
    currentProjectId: bigint("current_project_id", {
      mode: "number",
    }).notNull(),
    currentNumber: bigint("current_number", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("issue_addresses_project_number_idx").on(t.projectId, t.number),
    // Moving back into a project reads this to find the tombstone holding
    // the card's old number, and answering it with the wrong row would hand
    // out someone else's number. The index makes a broken write fail at the
    // write instead: at most one address per lineage per project.
    uniqueIndex("issue_addresses_lineage_project_idx").on(
      t.lineage,
      t.projectId,
    ),
    index("issue_addresses_lineage_idx").on(t.lineage),
  ],
);

// One row per move, and the coordinator of the cross-database protocol: with
// no transaction spanning two databases, this row's `state` is the only
// truth about how far a move got, and the recovery sweep drives it forward.
// Same trick pending_uploads plays — the registration row IS the worklist.
export const issueMoves = pgTable(
  "issue_moves",
  {
    id: id(),
    // Null until the address book exists: a card's first move registers this
    // row before the lineage it will belong to has been created.
    lineage: bigint("lineage", { mode: "number" }),
    // Claims the destination copy after a crash: the sweep finds the
    // moved_in event carrying this token, or knows the copy never landed.
    moveToken: text("move_token").notNull(),
    fromProjectId: bigint("from_project_id", { mode: "number" }).notNull(),
    fromNumber: bigint("from_number", { mode: "number" }).notNull(),
    toProjectId: bigint("to_project_id", { mode: "number" }).notNull(),
    // Assigned by the destination database, so it is unknown until step 4.
    toNumber: bigint("to_number", { mode: "number" }),
    actorId: bigint("actor_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    // Generated once and reused for the source freeze, the tombstone, and
    // both timeline events — which is what lets the sweep thaw a freeze it
    // can prove is its own (`moving_since = this row's moved_at`).
    movedAt: timestamp("moved_at", { withTimezone: true }).notNull(),
    state: text("state", { enum: ["copying", "copied", "done"] }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("issue_moves_token_idx").on(t.moveToken),
    index("issue_moves_state_idx").on(t.state),
  ],
);

// Old comment/attachment id → where it lives now (T-231). These ids are the
// externally visible ones — `#comment-N`, attachment URLs pasted into
// markdown — and a copy into another database cannot keep them, so the
// routes answer "no such id here" by asking this table.
//
// Flattening past A→B→A never cycles or shadows, on two premises:
//
//  1. Identity columns do not recycle. A comment id freed in A is never
//     handed to a later comment there, so no live row can ever sit on an
//     alias (the routes check live rows first and only then come here). Any
//     import or restore path using OVERRIDING SYSTEM VALUE breaks this table.
//  2. A tombstone holds its (project, number) forever, so moving back in
//     reuses the old number instead of colliding with it — which is also
//     what makes issue_addresses' (project_id, number) index safe.
export const movedIds = pgTable(
  "moved_ids",
  {
    id: id(),
    kind: text("kind", { enum: ["comment", "attachment"] }).notNull(),
    projectId: bigint("project_id", { mode: "number" }).notNull(),
    // Named ref_id because `id` is taken by this table's own key.
    refId: bigint("ref_id", { mode: "number" }).notNull(),
    currentProjectId: bigint("current_project_id", {
      mode: "number",
    }).notNull(),
    currentId: bigint("current_id", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("moved_ids_kind_project_ref_idx").on(
      t.kind,
      t.projectId,
      t.refId,
    ),
    // Flattening rewrites every row that pointed at the ids just copied.
    index("moved_ids_kind_current_idx").on(
      t.kind,
      t.currentProjectId,
      t.currentId,
    ),
  ],
);

// Deployment-wide settings, validated at the service layer. Holds
// `cross_refs_since`: the instant this instance ran the T-150 migration,
// which is the cutoff the cross-project grammar opens at.
export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["admin", "writer", "reader"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_id_idx").on(t.userId),
  ],
);
