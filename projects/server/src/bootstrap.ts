import { and, eq } from "drizzle-orm";
import type { Config } from "./config.ts";
import type { Db } from "./db/driver.ts";
import { DbRouter } from "./db/router.ts";
import { users } from "./db/system-schema.ts";
import { EventBus } from "./events/bus.ts";
import { FsStorage } from "./storage/fs.ts";
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
    storage: new FsStorage(config.storage.path),
    shutdown: new AbortController(),
  };
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
