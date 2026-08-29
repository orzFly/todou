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
