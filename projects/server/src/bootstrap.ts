import { and, eq } from "drizzle-orm";
import { type Config, ConfigError } from "./config.ts";
import type { Db } from "./db/driver.ts";
import { DbRouter } from "./db/router.ts";
import { users } from "./db/system-schema.ts";
import { EventBus } from "./events/bus.ts";
import { FsStorage } from "./storage/fs.ts";
import { S3Storage } from "./storage/s3.ts";
import type { StorageBackend } from "./storage/types.ts";

export const BUILTIN_LOGIN = "user";
// The built-in account is tracked by this oidc_subject sentinel, not by its
// login — logins are user-editable and single-mode auth must survive a rename.
export const BUILTIN_SUBJECT = "builtin";

export type AppContext = {
  config: Config;
  router: DbRouter;
  bus: EventBus;
  storage: StorageBackend;
  /**
   * Aborted once when the process is asked to stop. Long-lived responses
   * (SSE) end themselves on this signal so `server.close()` can complete
   * instead of waiting on connections that never finish (#56).
   */
  shutdown: AbortController;
};

export async function bootstrap(config: Config): Promise<AppContext> {
  const router = await DbRouter.open(config);
  if (config.auth.mode === "single") {
    await ensureBuiltinUser(router.system());
  }
  return {
    config,
    router,
    bus: new EventBus(),
    storage: await makeStorage(config),
    shutdown: new AbortController(),
  };
}

async function makeStorage(config: Config): Promise<StorageBackend> {
  if (config.storage.backend !== "s3") {
    return new FsStorage(config.storage.path);
  }
  if (!config.s3Credentials) {
    // loadConfig resolves credentials whenever backend is s3; reaching this
    // means a hand-built Config skipped it.
    throw new ConfigError("storage.backend is s3 but no credentials resolved");
  }
  const storage = new S3Storage(config.storage.s3, config.s3Credentials);
  await storage.checkBucket();
  console.log(
    `storage: s3 bucket "${config.storage.s3.bucket}" at ${config.storage.s3.endpoint} ` +
      `(credentials from ${config.s3Credentials.source})`,
  );
  return storage;
}

/** Single-user mode signs everyone in as this seeded account. */
export async function ensureBuiltinUser(db: Db): Promise<void> {
  const bySubject = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.oidcSubject, BUILTIN_SUBJECT));
  if (bySubject.length > 0) return;

  // Databases seeded before profile editing carry no subject marker —
  // adopt the account by its original login instead of duplicating it.
  const byLogin = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.login, BUILTIN_LOGIN), eq(users.kind, "human")));
  const existing = byLogin[0];
  if (existing) {
    await db
      .update(users)
      .set({ oidcSubject: BUILTIN_SUBJECT })
      .where(eq(users.id, existing.id));
    return;
  }

  await db.insert(users).values({
    kind: "human",
    login: BUILTIN_LOGIN,
    displayName: "User",
    oidcSubject: BUILTIN_SUBJECT,
    isInstanceAdmin: true,
  });
}
