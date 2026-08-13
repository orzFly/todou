import { randomInt } from "node:crypto";
import { Login } from "@todou/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/driver.ts";
import { users } from "../db/system-schema.ts";
import { ForbiddenError } from "../errors.ts";
import type { UserRow } from "./pat.ts";

/**
 * Kept as a class (not a bare 403) so the oidc callback can turn the reason
 * into a redirect code without parsing message strings; forward mode
 * rethrows it as a plain 403.
 */
export class ProvisionError extends ForbiddenError {
  readonly reason: "provision_denied";

  constructor(reason: "provision_denied", message: string) {
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
  /** IdP `sub` claim; in forward mode, the asserted username itself. */
  subject: string;
  /** Already normalized via normalizeLogin. */
  login: string;
  name?: string | null;
  email?: string | null;
};

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 4;
// Collision odds per suffixed attempt are ~existing/36⁴; five straight
// losses means something other than luck is broken.
const SUFFIX_ATTEMPTS = 5;
// Login schema caps at 64; leave room for "-" + the suffix.
const SUFFIX_BASE_MAX = 64 - SUFFIX_LENGTH - 1;

/** Unpredictable on purpose: logins must not leak registration order. */
export function randomLoginSuffix(): string {
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    suffix += SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)];
  }
  return suffix;
}

/**
 * Returns the violated constraint/index name when the error — anywhere in
 * its cause chain — is a Postgres unique violation, else null. node-postgres
 * and PGlite shape the error differently and drizzle may wrap either, so
 * walk the chain and fall back to parsing the message.
 */
export function uniqueViolation(error: unknown): string | null {
  let e: unknown = error;
  for (let depth = 0; e != null && depth < 10; depth++) {
    const { code, constraint, message } = e as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
    };
    const match =
      typeof message === "string"
        ? message.match(/violates unique constraint "([^"]+)"/)
        : null;
    if (code === "23505" || match) {
      return typeof constraint === "string" ? constraint : (match?.[1] ?? null);
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export type ProvisionOptions = {
  autoCreate: boolean;
  /** Test seam: replaces the crypto suffix source. */
  suffix?: () => string;
  /** Test seam: runs before each JIT attempt, to construct races. */
  beforeAttempt?: () => Promise<void>;
};

/**
 * Resolve an upstream-authenticated identity to a user row, keyed by the
 * subject ALONE. The IdP/proxy is fully trusted for WHO the request is —
 * but an asserted username is a public, re-registrable name, never proof
 * of ownership of an existing account, so it must not match one (T-86).
 * Unknown subjects are JIT-created; a taken login gets a random suffix
 * instead of adopting or refusing.
 */
export async function provisionUser(
  db: Db,
  input: IdentityInput,
  opts: ProvisionOptions,
): Promise<UserRow> {
  const found = await findBySubject(db, input.subject);
  if (found) return liveOrThrow(found);

  if (!opts.autoCreate) {
    throw new ProvisionError(
      "provision_denied",
      `no account for identity "${input.login}" (subject "${input.subject}") and auto_create is disabled`,
    );
  }

  // The Me schema serialises email as z.email() — an upstream value that
  // would not round-trip is dropped rather than poisoning every /me call.
  const email =
    input.email && z.email().safeParse(input.email).success
      ? input.email
      : null;
  const suffix = opts.suffix ?? randomLoginSuffix;

  for (let attempt = 0; attempt <= SUFFIX_ATTEMPTS; attempt++) {
    const login =
      attempt === 0
        ? input.login
        : `${input.login.slice(0, SUFFIX_BASE_MAX)}-${suffix()}`;
    await opts.beforeAttempt?.();
    try {
      // Create and the first-admin check in one transaction so two
      // concurrent first logins cannot both come out admin-less (or both
      // admin). A unique violation aborts the whole transaction, so the
      // retry loop wraps it.
      return await db.transaction(async (tx) => {
        const humans = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.kind, "human"))
          .limit(1);
        const inserted = await tx
          .insert(users)
          .values({
            kind: "human",
            login,
            displayName: input.name?.trim() || input.login,
            email,
            oidcSubject: input.subject,
            isInstanceAdmin: humans.length === 0,
          })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error("user insert returned no row");
        return row;
      });
    } catch (cause) {
      const constraint = uniqueViolation(cause);
      if (constraint === "users_oidc_subject_idx") {
        // Lost a same-subject race: the concurrent insert IS this identity.
        const winner = await findBySubject(db, input.subject);
        if (winner) return liveOrThrow(winner);
        throw cause;
      }
      if (constraint === "users_login_idx") continue;
      throw cause;
    }
  }
  throw new Error(
    `could not allocate a login for "${input.login}" after ${SUFFIX_ATTEMPTS} suffix attempts`,
  );
}

async function findBySubject(
  db: Db,
  subject: string,
): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.oidcSubject, subject));
  return rows[0];
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
