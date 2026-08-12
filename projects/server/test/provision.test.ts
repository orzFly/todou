import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureBuiltinUser } from "../src/bootstrap.ts";
import type { Db } from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import {
  normalizeLogin,
  ProvisionError,
  provisionUser,
} from "../src/auth/provision.ts";
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
  return rows[0]!;
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

describe("provisionUser", () => {
  it("matches by subject first, regardless of login drift", () => {
    return (async () => {
      const bound = await insertUser({
        login: "alice",
        oidcSubject: "sub-1",
      });
      const row = await provisionUser(
        db,
        { subject: "sub-1", login: "renamed-in-idp" },
        { autoCreate: false },
      );
      expect(row.id).toBe(bound.id);
    })();
  });

  it("adopts an unbound user by login and binds the subject", async () => {
    const legacy = await insertUser({ login: "alice" });
    const row = await provisionUser(
      db,
      { subject: "sub-9", login: "alice" },
      { autoCreate: false },
    );
    expect(row.id).toBe(legacy.id);
    expect(row.oidcSubject).toBe("sub-9");
  });

  it("adopts the builtin account: the single→oidc migration path", async () => {
    await ensureBuiltinUser(db);
    const builtin = (
      await db.select().from(users).where(eq(users.login, "user"))
    )[0]!;
    expect(builtin.isInstanceAdmin).toBe(true);

    const row = await provisionUser(
      db,
      { subject: "real-sub", login: "user" },
      { autoCreate: false },
    );
    expect(row.id).toBe(builtin.id);
    expect(row.oidcSubject).toBe("real-sub");
    expect(row.isInstanceAdmin).toBe(true);
  });

  it("forward mode (no subject) resolves by login without binding", async () => {
    const existing = await insertUser({
      login: "alice",
      oidcSubject: "bound-elsewhere",
    });
    const row = await provisionUser(
      db,
      { login: "alice" },
      { autoCreate: false },
    );
    expect(row.id).toBe(existing.id);
    expect(row.oidcSubject).toBe("bound-elsewhere");
  });

  it("rejects a login held by a machine account", async () => {
    await insertUser({ login: "bot", kind: "machine" });
    await expect(
      provisionUser(db, { login: "bot" }, { autoCreate: true }),
    ).rejects.toMatchObject({ reason: "login_conflict", status: 403 });
  });

  it("rejects a login bound to a different subject", async () => {
    await insertUser({ login: "alice", oidcSubject: "sub-1" });
    await expect(
      provisionUser(
        db,
        { subject: "sub-2", login: "alice" },
        { autoCreate: true },
      ),
    ).rejects.toMatchObject({ reason: "login_conflict" });
  });

  it("rejects unknown identities when auto_create is off", async () => {
    await expect(
      provisionUser(db, { login: "nobody" }, { autoCreate: false }),
    ).rejects.toMatchObject({ reason: "provision_denied" });
  });

  it("rejects disabled accounts on every path", async () => {
    await insertUser({
      login: "gone",
      oidcSubject: "sub-gone",
      disabledAt: new Date(),
    });
    for (const input of [
      { subject: "sub-gone", login: "whatever" },
      { login: "gone" },
    ]) {
      await expect(
        provisionUser(db, input, { autoCreate: true }),
      ).rejects.toMatchObject({ reason: "provision_denied" });
    }
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
      { login: "alice" },
      { autoCreate: true },
    );
    expect(row.isInstanceAdmin).toBe(true);
  });

  it("drops an email the Me schema could not serialise", async () => {
    const row = await provisionUser(
      db,
      { login: "alice", email: "not-an-email" },
      { autoCreate: true },
    );
    expect(row.email).toBeNull();
  });

  it("exposes ProvisionError as a 403 DomainError", async () => {
    const error = await provisionUser(
      db,
      { login: "nobody" },
      { autoCreate: false },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProvisionError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
  });
});
