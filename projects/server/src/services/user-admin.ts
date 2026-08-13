import { eq } from "drizzle-orm";
import { BUILTIN_SUBJECT } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { users } from "../db/system-schema.ts";

type UserRow = typeof users.$inferSelect;

/**
 * Offline account administration behind `todou-server user …` — the explicit
 * replacement for the login-adoption path provisioning no longer has (T-86).
 * Runs on the deployer's shell against the system database; there is no HTTP
 * surface, which is the point: migrating history onto an IdP identity is a
 * deliberate operator act, not something an asserted username can trigger.
 */

export class UserAdminError extends Error {}

export function listUsers(db: Db): Promise<UserRow[]> {
  return db.select().from(users).orderBy(users.id);
}

export type BindSubjectInput = {
  login: string;
  /** New subject value; mutually exclusive with `clear`. */
  subject?: string;
  clear?: boolean;
  /** Overwrite an existing binding / move the value off its current holder. */
  force?: boolean;
};

export type BindSubjectResult = {
  user: UserRow;
  /** The account the subject was moved off, when --force displaced one. */
  displaced?: UserRow;
};

export async function bindSubject(
  db: Db,
  input: BindSubjectInput,
): Promise<BindSubjectResult> {
  const target = await byLogin(db, input.login);
  if (target.kind !== "human") {
    throw new UserAdminError(
      `"${input.login}" is a machine account — machines authenticate with PATs, a subject binding would never be used`,
    );
  }

  if (input.clear) {
    const user = await setSubject(db, target.id, null);
    return { user };
  }

  const subject = input.subject;
  if (!subject) {
    throw new UserAdminError(
      "nothing to do: pass --subject <value> or --clear",
    );
  }
  if (target.oidcSubject === subject) return { user: target };
  if (isRealBinding(target.oidcSubject) && !input.force) {
    throw new UserAdminError(
      `"${input.login}" is already bound to subject "${target.oidcSubject}" — rerun with --force to overwrite`,
    );
  }

  const holderRows = await db
    .select()
    .from(users)
    .where(eq(users.oidcSubject, subject));
  const holder = holderRows[0];
  if (holder && holder.id !== target.id) {
    if (!input.force) {
      throw new UserAdminError(
        `subject "${subject}" is already bound to "${holder.login}" — rerun with --force to move it`,
      );
    }
    // Release before bind: the unique index is checked per statement.
    return db.transaction(async (tx) => {
      const displaced = await setSubject(tx, holder.id, null);
      const user = await setSubject(tx, target.id, subject);
      return { user, displaced };
    });
  }

  const user = await setSubject(db, target.id, subject);
  return { user };
}

export type AdoptInput = {
  /** The account that keeps the history (typically the ex-builtin). */
  into: string;
  /** The freshly JIT-created shell whose subject (and login) move over. */
  from: string;
  /** Keep `into`'s current login instead of taking `from`'s. */
  keepLogin?: boolean;
  /** Overwrite an existing binding on `into`. */
  force?: boolean;
};

export type AdoptResult = { into: UserRow; retired: UserRow };

export async function adoptUser(
  db: Db,
  input: AdoptInput,
): Promise<AdoptResult> {
  const into = await byLogin(db, input.into);
  const from = await byLogin(db, input.from);
  if (into.id === from.id) {
    throw new UserAdminError("--into and --from name the same account");
  }
  for (const row of [into, from]) {
    if (row.kind !== "human") {
      throw new UserAdminError(`"${row.login}" is a machine account`);
    }
  }
  if (from.oidcSubject === null) {
    throw new UserAdminError(
      `"${from.login}" has no subject to adopt — it never signed in through oidc/forward`,
    );
  }
  if (isRealBinding(into.oidcSubject) && !input.force) {
    throw new UserAdminError(
      `"${into.login}" is already bound to subject "${into.oidcSubject}" — rerun with --force to overwrite`,
    );
  }

  const marker = `-retired-${from.id}`;
  const retiredLogin = from.login.slice(0, 64 - marker.length) + marker;

  return db.transaction(async (tx) => {
    // Release the donor's login and subject before the receiver takes them:
    // both unique indexes are checked per statement.
    const retiredRows = await tx
      .update(users)
      .set({ login: retiredLogin, oidcSubject: null, disabledAt: new Date() })
      .where(eq(users.id, from.id))
      .returning();
    const intoRows = await tx
      .update(users)
      .set({
        oidcSubject: from.oidcSubject,
        ...(input.keepLogin ? {} : { login: from.login }),
      })
      .where(eq(users.id, into.id))
      .returning();
    const retired = retiredRows[0];
    const updated = intoRows[0];
    if (!retired || !updated) throw new Error("adopt updated no row");
    return { into: updated, retired };
  });
}

/**
 * The single-mode sentinel is a marker, not an IdP binding — adopting into
 * the ex-builtin account is THE canonical migration and must not demand the
 * same --force that unlocks overwriting a real binding.
 */
function isRealBinding(subject: string | null): boolean {
  return subject !== null && subject !== BUILTIN_SUBJECT;
}

async function byLogin(db: Db, login: string): Promise<UserRow> {
  const rows = await db.select().from(users).where(eq(users.login, login));
  const row = rows[0];
  if (!row) throw new UserAdminError(`no account with login "${login}"`);
  return row;
}

async function setSubject(
  db: Db,
  id: number,
  subject: string | null,
): Promise<UserRow> {
  const rows = await db
    .update(users)
    .set({ oidcSubject: subject })
    .where(eq(users.id, id))
    .returning();
  const row = rows[0];
  if (!row) throw new Error("subject update matched no row");
  return row;
}
