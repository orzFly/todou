import { MEMBER_ROLES } from "@todou/shared";
import {
  type AnyPgColumn,
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
    // Storage key of the uploaded project icon; null = REF/initials fallback.
    // Same shape and the same fresh-key-per-upload rule as a user's avatar.
    iconKey: text("icon_key"),
    iconContentType: text("icon_content_type"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("projects_slug_idx").on(t.slug)],
);

// A user's muted projects (T-372), by id rather than slug so a rename —
// which leaves the old address routing through slug_history — does not
// silently unmute. Lives in the system db beside user_prefs (not inside its
// jsonb: `||` shallow-merge would lose an array field to concurrent writes)
// so /me/inbox can read every project's mute in one query.
export const projectMutes = pgTable(
  "project_mutes",
  {
    id: id(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    mutedAt: timestamp("muted_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("project_mutes_project_user_idx").on(t.projectId, t.userId),
  ],
);

/**
 * "This card waits for that one" (T-377), one row per edge.
 *
 * System tier for the same reason as `issue_addresses`: the reverse direction
 * — which cards anywhere point at me — has to be answerable without opening
 * every project's database, and a second index in the project tier would be
 * a second truth with no transaction able to commit both.
 *
 * The two ends are LOGICAL addresses: `project_id` is a real foreign key, but
 * the issue row `(project_id, number)` names lives in another database, so
 * there is none to be had on the pair.
 */
export const issueBlocks = pgTable(
  "issue_blocks",
  {
    id: id(),
    // Only ever "blocks". Kept so that adding relates_to / duplicates later
    // is widening an enum rather than adding a column.
    type: text("type", { enum: ["blocks"] })
      .notNull()
      .default("blocks"),
    blockerProjectId: bigint("blocker_project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    blockerNumber: bigint("blocker_number", { mode: "number" }).notNull(),
    blockedProjectId: bigint("blocked_project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    blockedNumber: bigint("blocked_number", { mode: "number" }).notNull(),
    createdBy: bigint("created_by", { mode: "number" }).notNull(),
    createdAt: createdAt(),
    // The instant the blocker crossed its project's clear line; NULL = still
    // blocking. The conclusion is stored because the read path must never
    // open the blocker's database to work it out.
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    // When the clearing was announced on the blocked card. Separate from
    // `cleared_at` because landing an event is a cross-database write that
    // can fail while the conclusion cannot — this pair is what makes
    // "cleared, but nobody was told" a state the repair sweep can find.
    clearedNotifiedAt: timestamp("cleared_notified_at", { withTimezone: true }),
    // The blocker went to the trash: still blocking, and written here by the
    // blocker's own side so a reader never has to go and look.
    blockerDeletedAt: timestamp("blocker_deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("issue_blocks_edge_idx").on(
      t.blockerProjectId,
      t.blockerNumber,
      t.blockedProjectId,
      t.blockedNumber,
    ),
    index("issue_blocks_blocked_idx").on(t.blockedProjectId, t.blockedNumber),
    index("issue_blocks_blocker_idx").on(t.blockerProjectId, t.blockerNumber),
  ],
);

// Mirror of every project's ref_formats history (T-150). Resolving a bare
// `PREFIX-N` written in project A means asking who holds that prefix across
// ALL projects — a question the per-project tables cannot answer without
// opening every database in the deployment.
//
// Readers want only the newest row per project (T-512), and the rest is kept
// anyway, for three reasons that each stand on their own. `syncRefPrefixMirror`
// repairs the mirror by diffing the WHOLE source history against the WHOLE
// mirror on `(effective_from, prefix)`, so a trimmed table would look like a
// gap and be refilled on every boot. The outbox's pending marks and its
// start-up re-copy read this as the mirror of that history, and would find the
// same phantom gaps. And the table grows by one row per administrator-made
// format change rather than with user traffic, so there is nothing here worth
// the irreversibility of deleting rows.
//
// `ref_prefixes_project_from_idx` only partly serves the newest-row-per-project
// read: postgres can walk it for ordered project_ids and Incremental Sort each
// group. An index on `(project_id, effective_from desc, id desc)` would fit
// exactly, and is not worth having on a table this size.
export const refPrefixes = pgTable(
  "ref_prefixes",
  {
    id: id(),
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // NULL = "#N", and the row still matters: as the newest row for its
    // project it says that project holds no prefix at all.
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

// A row here means "this project's mirror above has not been checked clean
// twice in a row yet" (T-511) — not "here is an effect waiting to be
// replayed". There is no payload because there is nothing to replay: the
// drainer re-derives the whole answer from ref_formats, so an over-report
// costs one read and a stale row can never write the wrong thing.
//
// `generation` counts marks instead of stamping a time because the drainer's
// delete is guarded by equality on it: PGlite's now() stops at the
// millisecond, so two marks inside one millisecond would hand out the same
// token and let the drainer delete a window it never checked.
//
// `verified_generation` exists because one clean pass is not enough. A mark
// commits before the authoritative write does, so the drainer can claim it,
// read a ref_formats that does not yet contain the row, and find nothing
// missing — deleting there would drop a hole that is about to open. The
// first clean pass only raises this column; the second one deletes.
//
// The cascade is load-bearing: createProject's dedicated branch compensates
// a failure by deleting the registry row, and the mark is written before
// that point.
export const pendingPrefixMirrors = pgTable(
  "pending_prefix_mirrors",
  {
    projectId: bigint("project_id", { mode: "number" })
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    verifiedGeneration: bigint("verified_generation", { mode: "number" })
      .notNull()
      .default(0),
    firstMarkedAt: timestamp("first_marked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
  },
  (t) => [index("pending_prefix_mirrors_due_idx").on(t.nextAttemptAt)],
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

// Deployment-wide settings, validated at the service layer.
//
// The `cross_refs_since` row is still seeded by `0005_cross-refs.sql` and no
// longer read by anything: T-260 took the cutoff out of the grammar. It is
// kept rather than deleted because the code that read it failed closed on a
// missing row — a rollback to any pre-T-260 build would find nothing and turn
// the whole cross-project grammar off deployment-wide.
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
    // Taken from the schema rather than spelled again: the column is plain
    // `text` in postgres, so this list is a TypeScript-only constraint and a
    // copy that fell behind would narrow reads, not reject writes.
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_user_id_idx").on(t.userId),
  ],
);

/**
 * Agents told to stop asking for access to a project (T-280). Beside
 * project_members because it is the same kind of fact — who stands in what
 * relation to this project — and it inherits the same cascade: a deleted
 * project has nothing left to be denied about.
 *
 * `deniedBy` is kept although nothing enforces anything with it: whoever
 * clicked Deny may have been a mere reader, and the row is undone from the
 * project's settings page by people who need to know who decided this.
 */
export const projectAccessDenials = pgTable(
  "project_access_denials",
  {
    projectId: bigint("project_id", { mode: "number" })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    deniedBy: bigint("denied_by", { mode: "number" })
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    // The CLI's hint asks "am I denied here", one caller against one
    // project, which is the leading-column half of the primary key — this
    // index is for the other direction: every denial one agent has.
    index("project_access_denials_user_id_idx").on(t.userId),
  ],
);
