import {
  type AnyPgColumn,
  bigint,
  boolean,
  index,
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
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    // Soft deactivation (used for agents): blocks all authentication.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_login_idx").on(t.login)],
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
