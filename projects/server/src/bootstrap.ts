import { eq } from "drizzle-orm";
import type { Config } from "./config.ts";
import type { Db } from "./db/driver.ts";
import { DbRouter } from "./db/router.ts";
import { users } from "./db/system-schema.ts";
import { EventBus } from "./events/bus.ts";
import { FsStorage } from "./storage/fs.ts";
import type { StorageBackend } from "./storage/types.ts";

export const BUILTIN_LOGIN = "user";

export type AppContext = {
  config: Config;
  router: DbRouter;
  bus: EventBus;
  storage: StorageBackend;
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
  };
}

/** Single-user mode signs everyone in as this seeded account. */
export async function ensureBuiltinUser(db: Db): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.login, BUILTIN_LOGIN));
  if (existing.length === 0) {
    await db.insert(users).values({
      kind: "human",
      login: BUILTIN_LOGIN,
      displayName: "User",
      isInstanceAdmin: true,
    });
  }
}
