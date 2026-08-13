import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeLogin,
  ProvisionError,
  provisionUser,
  randomLoginSuffix,
  uniqueViolation,
} from "../src/auth/provision.ts";
import { BUILTIN_SUBJECT, ensureBuiltinUser } from "../src/bootstrap.ts";
import type { Db } from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import { makeRouter } from "./helpers.ts";

let router: DbRouter;
let db: Db;

beforeEach(async () => {
  ({ router } = await makeRouter());
  db = router.system();
});

afterEach(() => router.close());

async function insertUser(
  values: Partial<typeof users.$inferInsert> & { login: string },
) {
  const rows = await db
    .insert(users)
    .values({
      kind: "human",
      displayName: values.login,
      ...values,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("user insert returned no row");
  return row;
}

async function rowById(id: number) {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0];
}

describe("normalizeLogin", () => {
  it("lowercases and validates", () => {
    expect(normalizeLogin("Alice")).toBe("alice");
    expect(normalizeLogin("  bob-2 ")).toBe("bob-2");
    expect(normalizeLogin("john.doe")).toBeNull();
    expect(normalizeLogin("")).toBeNull();
    expect(normalizeLogin("-lead")).toBeNull();
    // Reserved logins must never be minted by an IdP claim.
    expect(normalizeLogin("me")).toBeNull();
  });
});

describe("randomLoginSuffix", () => {
  it("is four lowercase alphanumerics", () => {
    for (let i = 0; i < 20; i++) {
      expect(randomLoginSuffix()).toMatch(/^[a-z0-9]{4}$/);
    }
  });
});

describe("uniqueViolation", () => {
  it("reads node-postgres shaped errors (code + constraint)", () => {
    const err = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "users_login_idx",
    });
    expect(uniqueViolation(err)).toBe("users_login_idx");
  });

  it("falls back to the canonical message text", () => {
    const err = new Error(
      'duplicate key value violates unique constraint "users_oidc_subject_idx"',
    );
    expect(uniqueViolation(err)).toBe("users_oidc_subject_idx");
  });

  it("walks the cause chain of wrapped errors", () => {
    const inner = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "users_login_idx",
    });
    const outer = new Error("query failed", { cause: inner });
    expect(uniqueViolation(outer)).toBe("users_login_idx");
  });

  it("returns null for anything else", () => {
    expect(uniqueViolation(new Error("connection refused"))).toBeNull();
    expect(uniqueViolation(undefined)).toBeNull();
  });
});

describe("provisionUser", () => {
  it("matches by subject first, regardless of login drift", async () => {
    const bound = await insertUser({ login: "alice", oidcSubject: "sub-1" });
    const row = await provisionUser(
      db,
      { subject: "sub-1", login: "renamed-in-idp" },
      { autoCreate: false },
    );
    expect(row.id).toBe(bound.id);
  });

  // The #86 attack, constructed: an IdP-side registration of an existing
  // human's username must never take over that account.
  it("never adopts an unbound human whose login the IdP asserts", async () => {
    const victim = await insertUser({ login: "alice" });
    expect(victim.oidcSubject).toBeNull();

    const row = await provisionUser(
      db,
      { subject: "attacker-sub", login: "alice" },
      { autoCreate: true },
    );
    expect(row.id).not.toBe(victim.id);
    expect(row.login).toMatch(/^alice-[a-z0-9]{4}$/);
    expect(row.oidcSubject).toBe("attacker-sub");

    // Field by field: the victim's account is untouched.
    expect(await rowById(victim.id)).toEqual(victim);
  });

  it("never adopts a human bound to a different subject", async () => {
    const bound = await insertUser({ login: "bob", oidcSubject: "sub-real" });
    const row = await provisionUser(
      db,
      { subject: "sub-other", login: "bob" },
      { autoCreate: true },
    );
    expect(row.id).not.toBe(bound.id);
    expect(row.login).toMatch(/^bob-[a-z0-9]{4}$/);
    expect(await rowById(bound.id)).toEqual(bound);
  });

  it("never adopts the ex-single-mode builtin account", async () => {
    await ensureBuiltinUser(db);
    const seeded = await db.select().from(users).where(eq(users.login, "user"));
    const builtin = seeded[0];
    if (!builtin) throw new Error("builtin user was not seeded");
    expect(builtin.isInstanceAdmin).toBe(true);

    const row = await provisionUser(
      db,
      { subject: "real-sub", login: "user" },
      { autoCreate: true },
    );
    expect(row.id).not.toBe(builtin.id);
    expect(row.login).toMatch(/^user-[a-z0-9]{4}$/);
    const untouched = await rowById(builtin.id);
    expect(untouched).toEqual(builtin);
    expect(untouched?.oidcSubject).toBe(BUILTIN_SUBJECT);
  });

  it("suffixes past a machine-held login instead of 403ing", async () => {
    const bot = await insertUser({ login: "bot", kind: "machine" });
    const row = await provisionUser(
      db,
      { subject: "human-sub", login: "bot" },
      { autoCreate: true },
    );
    expect(row.kind).toBe("human");
    expect(row.login).toMatch(/^bot-[a-z0-9]{4}$/);
    expect(await rowById(bot.id)).toEqual(bot);
  });

  it("keeps the identity when the login is renamed inside todou", async () => {
    const created = await provisionUser(
      db,
      { subject: "stable-sub", login: "carol" },
      { autoCreate: true },
    );
    await db
      .update(users)
      .set({ login: "renamed" })
      .where(eq(users.id, created.id));
    const again = await provisionUser(
      db,
      { subject: "stable-sub", login: "carol" },
      { autoCreate: false },
    );
    expect(again.id).toBe(created.id);
  });

  it("uses the bare login when it is free", async () => {
    const row = await provisionUser(
      db,
      { subject: "sub-a", login: "alice" },
      { autoCreate: true },
    );
    expect(row.login).toBe("alice");
  });

  it("truncates a long base so the suffixed login fits the 64 cap", async () => {
    const long = "a".repeat(64);
    await insertUser({ login: long });
    const row = await provisionUser(
      db,
      { subject: "long-sub", login: long },
      { autoCreate: true },
    );
    expect(row.login).toMatch(/^a{59}-[a-z0-9]{4}$/);
    expect(row.login.length).toBe(64);
  });

  it("retries with a fresh suffix when the suffixed login collides", async () => {
    await insertUser({ login: "alice" });
    await insertUser({ login: "alice-aaaa" });
    const seq = ["aaaa", "bbbb"];
    const row = await provisionUser(
      db,
      { subject: "seq-sub", login: "alice" },
      { autoCreate: true, suffix: () => seq.shift() ?? "zzzz" },
    );
    expect(row.login).toBe("alice-bbbb");
  });

  it("gives up after exhausting the suffix attempts", async () => {
    await insertUser({ login: "alice" });
    await insertUser({ login: "alice-aaaa" });
    await expect(
      provisionUser(
        db,
        { subject: "stuck-sub", login: "alice" },
        { autoCreate: true, suffix: () => "aaaa" },
      ),
    ).rejects.toThrow(/could not allocate a login/);
  });

  it("returns the winner of a same-subject race, not a duplicate", async () => {
    let raced = false;
    const row = await provisionUser(
      db,
      { subject: "race-sub", login: "alice" },
      {
        autoCreate: true,
        // Runs between the subject lookup (miss) and the insert — the
        // interleaving a concurrent login would produce.
        beforeAttempt: async () => {
          if (raced) return;
          raced = true;
          await insertUser({ login: "winner", oidcSubject: "race-sub" });
        },
      },
    );
    expect(row.login).toBe("winner");
    const all = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, "race-sub"));
    expect(all).toHaveLength(1);
  });

  it("rejects unknown identities when auto_create is off", async () => {
    const error = await provisionUser(
      db,
      { subject: "sub-x", login: "nobody" },
      { autoCreate: false },
    ).catch((e) => e);
    expect(error).toMatchObject({ reason: "provision_denied", status: 403 });
    expect(error.message).toContain("nobody");
    expect(error.message).toContain("sub-x");
  });

  it("rejects disabled accounts on the subject match", async () => {
    await insertUser({
      login: "gone",
      oidcSubject: "sub-gone",
      disabledAt: new Date(),
    });
    await expect(
      provisionUser(
        db,
        { subject: "sub-gone", login: "whatever" },
        { autoCreate: true },
      ),
    ).rejects.toMatchObject({ reason: "provision_denied" });
  });

  it("JIT-creates with claims applied and first-human-becomes-admin", async () => {
    const first = await provisionUser(
      db,
      {
        subject: "sub-a",
        login: "alice",
        name: "Alice W",
        email: "alice@example.com",
      },
      { autoCreate: true },
    );
    expect(first.kind).toBe("human");
    expect(first.displayName).toBe("Alice W");
    expect(first.email).toBe("alice@example.com");
    expect(first.oidcSubject).toBe("sub-a");
    expect(first.isInstanceAdmin).toBe(true);

    const second = await provisionUser(
      db,
      { subject: "sub-b", login: "bob" },
      { autoCreate: true },
    );
    expect(second.displayName).toBe("bob");
    expect(second.isInstanceAdmin).toBe(false);
  });

  it("does not count machine users towards the first-admin rule", async () => {
    await insertUser({ login: "bot", kind: "machine" });
    const row = await provisionUser(
      db,
      { subject: "sub-a", login: "alice" },
      { autoCreate: true },
    );
    expect(row.isInstanceAdmin).toBe(true);
  });

  it("drops an email the Me schema could not serialise", async () => {
    const row = await provisionUser(
      db,
      { subject: "sub-a", login: "alice", email: "not-an-email" },
      { autoCreate: true },
    );
    expect(row.email).toBeNull();
  });

  it("exposes ProvisionError as a 403 DomainError", async () => {
    const error = await provisionUser(
      db,
      { subject: "sub-x", login: "nobody" },
      { autoCreate: false },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProvisionError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
  });
});
