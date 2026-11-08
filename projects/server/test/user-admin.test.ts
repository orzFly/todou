import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import type { DbRouter } from "../src/db/router.ts";
import { users } from "../src/db/system-schema.ts";
import {
  adoptUser,
  bindSubject,
  listUsers,
  setInstanceAdmin,
  UserAdminError,
} from "../src/services/user-admin.ts";
import {
  addUserWithToken,
  makeRouter,
  makeTestApp,
  type TestApp,
} from "./helpers.ts";

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
  const row = rows[0];
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

describe("listUsers", () => {
  it("returns every account in id order", async () => {
    await insertUser({ login: "alice" });
    await insertUser({ login: "bot", kind: "machine" });
    const rows = await listUsers(db);
    expect(rows.map((r) => r.login)).toEqual(["alice", "bot"]);
  });
});

describe("bindSubject", () => {
  it("binds an unbound human", async () => {
    const alice = await insertUser({ login: "alice" });
    const { user, displaced } = await bindSubject(db, {
      login: "alice",
      subject: "sub-1",
    });
    expect(user.id).toBe(alice.id);
    expect(user.oidcSubject).toBe("sub-1");
    expect(displaced).toBeUndefined();
  });

  it("is a no-op when the binding already matches", async () => {
    await insertUser({ login: "alice", oidcSubject: "sub-1" });
    const { user } = await bindSubject(db, {
      login: "alice",
      subject: "sub-1",
    });
    expect(user.oidcSubject).toBe("sub-1");
  });

  it("refuses machine accounts outright", async () => {
    await insertUser({ login: "bot", kind: "machine" });
    await expect(
      bindSubject(db, { login: "bot", subject: "sub-1", force: true }),
    ).rejects.toThrow(UserAdminError);
  });

  it("refuses to overwrite an existing binding without --force", async () => {
    await insertUser({ login: "alice", oidcSubject: "sub-old" });
    await expect(
      bindSubject(db, { login: "alice", subject: "sub-new" }),
    ).rejects.toThrow(/already bound/);
    const forced = await bindSubject(db, {
      login: "alice",
      subject: "sub-new",
      force: true,
    });
    expect(forced.user.oidcSubject).toBe("sub-new");
  });

  it("treats the builtin sentinel as unbound (no --force needed)", async () => {
    await insertUser({ login: "user", oidcSubject: "builtin" });
    const { user } = await bindSubject(db, {
      login: "user",
      subject: "real-sub",
    });
    expect(user.oidcSubject).toBe("real-sub");
  });

  it("refuses to displace another holder without --force, moves with it", async () => {
    const holder = await insertUser({ login: "bob", oidcSubject: "sub-1" });
    await insertUser({ login: "alice" });
    await expect(
      bindSubject(db, { login: "alice", subject: "sub-1" }),
    ).rejects.toThrow(/bound to "bob"/);

    const moved = await bindSubject(db, {
      login: "alice",
      subject: "sub-1",
      force: true,
    });
    expect(moved.user.oidcSubject).toBe("sub-1");
    expect(moved.displaced?.id).toBe(holder.id);
    expect((await rowById(holder.id)).oidcSubject).toBeNull();
  });

  it("clears a binding", async () => {
    await insertUser({ login: "alice", oidcSubject: "sub-1" });
    const { user } = await bindSubject(db, { login: "alice", clear: true });
    expect(user.oidcSubject).toBeNull();
  });

  it("errors on unknown logins and on missing --subject", async () => {
    await expect(
      bindSubject(db, { login: "ghost-login", subject: "s" }),
    ).rejects.toThrow(/no account/);
    await insertUser({ login: "alice" });
    await expect(bindSubject(db, { login: "alice" })).rejects.toThrow(
      /nothing to do/,
    );
  });
});

describe("adoptUser", () => {
  // The single → oidc migration: "user" holds the history, "newcomer" is the
  // freshly JIT-created shell from the first oidc login.
  it("moves subject + login onto the history account and retires the shell", async () => {
    const history = await insertUser({
      login: "user",
      oidcSubject: "builtin",
      isInstanceAdmin: true,
    });
    const shell = await insertUser({ login: "newcomer", oidcSubject: "sub-9" });

    // No --force needed: the builtin sentinel is a marker, not a binding.
    const result = await adoptUser(db, { into: "user", from: "newcomer" });

    expect(result.into.id).toBe(history.id);
    expect(result.into.login).toBe("newcomer");
    expect(result.into.oidcSubject).toBe("sub-9");
    expect(result.into.isInstanceAdmin).toBe(true);

    expect(result.retired.id).toBe(shell.id);
    expect(result.retired.login).toBe(`newcomer-retired-${shell.id}`);
    expect(result.retired.oidcSubject).toBeNull();
    expect(result.retired.disabledAt).not.toBeNull();
  });

  it("keeps the current login with --keep-login", async () => {
    await insertUser({ login: "history" });
    await insertUser({ login: "fresh", oidcSubject: "sub-9" });
    const result = await adoptUser(db, {
      into: "history",
      from: "fresh",
      keepLogin: true,
    });
    expect(result.into.login).toBe("history");
    expect(result.into.oidcSubject).toBe("sub-9");
    expect(result.retired.login).toMatch(/^fresh-retired-\d+$/);
  });

  it("truncates the retired login to the 64-char cap", async () => {
    const long = "b".repeat(64);
    await insertUser({ login: "history" });
    const shell = await insertUser({ login: long, oidcSubject: "sub-9" });
    const result = await adoptUser(db, { into: "history", from: long });
    expect(result.retired.login.length).toBeLessThanOrEqual(64);
    expect(result.retired.login.endsWith(`-retired-${shell.id}`)).toBe(true);
  });

  it("refuses: unbound donor, bound receiver without --force, machines, self", async () => {
    await insertUser({ login: "nosub" });
    await insertUser({ login: "target" });
    await expect(
      adoptUser(db, { into: "target", from: "nosub" }),
    ).rejects.toThrow(/no subject to adopt/);

    await insertUser({ login: "bound", oidcSubject: "sub-a" });
    await insertUser({ login: "donor", oidcSubject: "sub-b" });
    await expect(
      adoptUser(db, { into: "bound", from: "donor" }),
    ).rejects.toThrow(/--force/);

    await insertUser({ login: "bot", kind: "machine" });
    await expect(adoptUser(db, { into: "bot", from: "donor" })).rejects.toThrow(
      /machine account/,
    );

    await expect(
      adoptUser(db, { into: "donor", from: "donor" }),
    ).rejects.toThrow(/same account/);
  });

  it("overwrites the receiver's binding with --force", async () => {
    await insertUser({ login: "bound", oidcSubject: "sub-old" });
    await insertUser({ login: "donor", oidcSubject: "sub-new" });
    const result = await adoptUser(db, {
      into: "bound",
      from: "donor",
      force: true,
    });
    expect(result.into.oidcSubject).toBe("sub-new");
    expect(result.into.login).toBe("donor");
  });
});

describe("setInstanceAdmin", () => {
  it("promotes and demotes, reporting what is left", async () => {
    const first = await insertUser({ login: "first", isInstanceAdmin: true });
    const alice = await insertUser({ login: "alice" });

    const up = await setInstanceAdmin(db, "alice", true);
    expect(up).toMatchObject({ changed: true, admins: 2 });
    expect((await rowById(alice.id)).isInstanceAdmin).toBe(true);

    const down = await setInstanceAdmin(db, "first", false);
    expect(down).toMatchObject({ changed: true, admins: 1 });
    expect((await rowById(first.id)).isInstanceAdmin).toBe(false);
  });

  it("is a no-op on an account already in that state", async () => {
    const alice = await insertUser({ login: "alice" });
    const result = await setInstanceAdmin(db, "alice", false);
    expect(result).toMatchObject({ changed: false, admins: 0 });
    expect(await rowById(alice.id)).toEqual(alice);
  });

  it("refuses machines, disabled accounts and unknown logins", async () => {
    await insertUser({ login: "bot", kind: "machine" });
    await expect(setInstanceAdmin(db, "bot", true)).rejects.toThrow(
      /machine account/,
    );
    await insertUser({ login: "gone", disabledAt: new Date() });
    await expect(setInstanceAdmin(db, "gone", true)).rejects.toThrow(
      /disabled/,
    );
    await expect(setInstanceAdmin(db, "nobody", true)).rejects.toThrow(
      UserAdminError,
    );
  });

  it("lets a disabled account be demoted", async () => {
    const gone = await insertUser({
      login: "gone",
      isInstanceAdmin: true,
      disabledAt: new Date(),
    });
    await setInstanceAdmin(db, "gone", false);
    expect((await rowById(gone.id)).isInstanceAdmin).toBe(false);
  });
});

describe("instance admin bit on a running app", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(() => t.cleanup());

  it("opens and closes every private project on the next request", async () => {
    const owner = {
      cookie: await t.login(),
      "content-type": "application/json",
    };
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ slug: "secret", name: "secret" }),
    });
    expect(created.status).toBe(201);
    const mallory = await addUserWithToken(t.ctx, "mallory");
    const system = t.ctx.router.system();
    const sees = async () => {
      const res = await t.app.request("/api/projects/secret", {
        headers: mallory.headers,
      });
      return res.status;
    };

    expect(await sees()).toBe(404);
    await setInstanceAdmin(system, "mallory", true);
    expect(await sees()).toBe(200);
    await setInstanceAdmin(system, "mallory", false);
    expect(await sees()).toBe(404);
  });
});
