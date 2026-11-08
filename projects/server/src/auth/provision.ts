import { randomInt } from "node:crypto";
import { Login, LoginInput } from "@todou/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { BUILTIN_SUBJECT } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import { users } from "../db/system-schema.ts";
import { ForbiddenError } from "../errors.ts";
import type { UserRow } from "./pat.ts";

/** Arbitrary, fixed key for the first-human-is-admin advisory lock. */
const FIRST_ADMIN_LOCK = 631_632;

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
 *
 * A forward deployment without auth.forward.subject_header stores this
 * output as the durable subject, so for every value it accepts today the
 * output must never change — or those accounts stop matching. Widening
 * what it accepts (T-676) is safe only for inputs that now return null.
 */
export function normalizeLogin(raw: string): string | null {
  const login = raw.trim().toLowerCase();
  return Login.safeParse(login).success ? login : null;
}

export type IdentityInput = {
  /**
   * IdP `sub` claim; in forward mode the subject_header value, or the
   * normalized username when none is configured.
   */
  subject: string;
  /**
   * Already normalized via normalizeLogin, which does not make it a login
   * a new account may take as is (all digits would shadow /users/<id>).
   */
  login: string;
  name?: string | null;
  email?: string | null;
  /**
   * Subjects the account held before it was re-keyed onto `subject`. Tried
   * in order only when `subject` matches nothing; a match is re-keyed to
   * `subject`, so each one can claim an account at most once.
   */
  legacySubjects?: string[];
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
  /** Test seam: runs before the legacy re-key update, to construct races. */
  beforeRekey?: () => Promise<void>;
};

/**
 * Resolve an upstream-authenticated identity to a user row, keyed by the
 * subject ALONE. The IdP/proxy is fully trusted for WHO the request is —
 * but an asserted username is a public, re-registrable name, never proof
 * of ownership of an existing account, so it must not match one (T-86).
 * Unknown subjects are JIT-created; a taken or all-digit login gets a
 * random suffix instead of adopting or refusing.
 */
export async function provisionUser(
  db: Db,
  input: IdentityInput,
  opts: ProvisionOptions,
): Promise<UserRow> {
  const found = await findBySubject(db, input.subject);
  if (found) return liveOrThrow(found);

  const rekeyed = await rekeyLegacy(db, input, opts);
  if (rekeyed) return rekeyed;

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
  // JIT is the one path that skips the LoginInput rules renames obey; a
  // suffixed login always contains "-", so starting there satisfies them.
  const first = LoginInput.safeParse(input.login).success ? 0 : 1;

  for (let attempt = first; attempt <= SUFFIX_ATTEMPTS; attempt++) {
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
        // The transaction alone is not enough: under READ COMMITTED two
        // first logins on different pool connections each count zero
        // humans, and with distinct logins and subjects no unique index
        // stops the second insert. The lock serialises count-then-insert;
        // it is released at commit, and PGlite is single-connection anyway.
        await tx.execute(
          sql`select pg_advisory_xact_lock(${FIRST_ADMIN_LOCK}::bigint)`,
        );
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

/**
 * The migration path of auth.forward.migrate_legacy_subjects: an account
 * still keyed by a pre-subject_header value moves onto the stable subject
 * the first time its owner signs in. Until then the legacy value — often a
 * reissuable username — can still claim it, which is why the switch is
 * meant to be on only for the migration window.
 */
async function rekeyLegacy(
  db: Db,
  input: IdentityInput,
  opts: ProvisionOptions,
): Promise<UserRow | undefined> {
  for (const legacy of new Set(input.legacySubjects ?? [])) {
    // The single-mode sentinel is a marker, not anybody's identity; an
    // upstream username "builtin" must not walk off with the admin account
    // (T-627 moves the marker out of this column and makes this redundant).
    if (legacy === BUILTIN_SUBJECT || legacy === input.subject) continue;
    const row = await findBySubject(db, legacy);
    if (!row || row.kind !== "human") continue;
    liveOrThrow(row);
    await opts.beforeRekey?.();
    let updated: UserRow[];
    try {
      updated = await db
        .update(users)
        .set({ oidcSubject: input.subject })
        .where(and(eq(users.id, row.id), eq(users.oidcSubject, legacy)))
        .returning();
    } catch (cause) {
      if (uniqueViolation(cause) !== "users_oidc_subject_idx") throw cause;
      // A concurrent request of this identity re-keyed or created first.
      const winner = await findBySubject(db, input.subject);
      if (winner) return liveOrThrow(winner);
      throw cause;
    }
    const done = updated[0];
    if (done) {
      console.log(
        `provision: re-keyed account "${done.login}" (id ${done.id}) from its legacy subject`,
      );
      return done;
    }
    // Zero rows: the legacy subject moved under us, most likely onto this
    // very identity by a concurrent login.
    const winner = await findBySubject(db, input.subject);
    if (winner) return liveOrThrow(winner);
  }
  return undefined;
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
