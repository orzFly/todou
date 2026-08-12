import { Login } from "@todou/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { BUILTIN_SUBJECT } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { users } from "../db/system-schema.ts";
import { ForbiddenError } from "../errors.ts";
import type { UserRow } from "./pat.ts";

/**
 * Distinguishes the two 403 families for the oidc callback's redirect codes
 * without parsing message strings; forward mode rethrows it as a plain 403.
 */
export class ProvisionError extends ForbiddenError {
  readonly reason: "login_conflict" | "provision_denied";

  constructor(reason: "login_conflict" | "provision_denied", message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Lowercase and validate an upstream-asserted login (oidc claim or forward
 * header). Returns null when the value cannot be a todou login — the CALLER
 * decides the status: 401 for forward (identity not establishable), a
 * claim_missing redirect for the oidc callback.
 */
export function normalizeLogin(raw: string): string | null {
  const login = raw.trim().toLowerCase();
  return Login.safeParse(login).success ? login : null;
}

export type IdentityInput = {
  /** IdP `sub` claim; absent in forward mode (identity key is the login). */
  subject?: string;
  /** Already normalized via normalizeLogin. */
  login: string;
  name?: string | null;
  email?: string | null;
};

/**
 * Resolve an upstream-authenticated identity to a user row, per the approved
 * order: subject match → login adoption → JIT creation. The IdP/proxy is
 * fully trusted for WHO the request is; this function only decides whether
 * that identity maps to an account here.
 */
export async function provisionUser(
  db: Db,
  input: IdentityInput,
  opts: { autoCreate: boolean },
): Promise<UserRow> {
  if (input.subject !== undefined) {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, input.subject));
    const row = rows[0];
    if (row) return liveOrThrow(row);
  }

  const byLogin = await db
    .select()
    .from(users)
    .where(eq(users.login, input.login));
  const existing = byLogin[0];
  if (existing) {
    if (existing.kind !== "human") {
      throw new ProvisionError(
        "login_conflict",
        `login "${input.login}" belongs to a machine account`,
      );
    }
    if (input.subject === undefined) return liveOrThrow(existing);
    // The builtin sentinel counts as unbound: this is how a single-mode
    // deployment's history gets adopted on the first oidc login.
    if (
      existing.oidcSubject === null ||
      existing.oidcSubject === BUILTIN_SUBJECT
    ) {
      liveOrThrow(existing);
      const updated = await db
        .update(users)
        .set({ oidcSubject: input.subject })
        .where(eq(users.id, existing.id))
        .returning();
      const row = updated[0];
      if (!row) throw new Error("subject adoption updated no row");
      return row;
    }
    throw new ProvisionError(
      "login_conflict",
      `login "${input.login}" is already bound to a different identity`,
    );
  }

  if (!opts.autoCreate) {
    throw new ProvisionError(
      "provision_denied",
      `unknown identity "${input.login}" and auto_create is disabled`,
    );
  }

  // The Me schema serialises email as z.email() — an upstream value that
  // would not round-trip is dropped rather than poisoning every /me call.
  const email =
    input.email && z.email().safeParse(input.email).success
      ? input.email
      : null;

  // Create and the first-admin check in one transaction so two concurrent
  // first logins cannot both come out admin-less (or both admin).
  return db.transaction(async (tx) => {
    const humans = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.kind, "human"))
      .limit(1);
    const inserted = await tx
      .insert(users)
      .values({
        kind: "human",
        login: input.login,
        displayName: input.name?.trim() || input.login,
        email,
        oidcSubject: input.subject ?? null,
        isInstanceAdmin: humans.length === 0,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("user insert returned no row");
    return row;
  });
}

function liveOrThrow(row: UserRow): UserRow {
  if (row.disabledAt) {
    throw new ProvisionError(
      "provision_denied",
      `account "${row.login}" is disabled`,
    );
  }
  return row;
}
