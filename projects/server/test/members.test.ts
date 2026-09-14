import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectMembers } from "../src/db/system-schema.ts";
import { findProjectByRef } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Headers = Record<string, string>;
type Actor = { id: number; login: string; headers: Headers };

/**
 * The membership rules a machine's owner brings with them (T-340): a machine
 * never outranks its owner, demoting or removing the owner carries the
 * machines with them, and the project keeps an admin through all of it.
 */
describe("project members and the owner ceiling (T-340)", () => {
  let t: TestApp;
  let seq = 0;

  beforeAll(async () => {
    t = await makeTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const sending = (headers: Headers): Headers => ({
    "content-type": "application/json",
    ...headers,
  });

  async function human(
    login: string,
    opts?: { instanceAdmin?: true },
  ): Promise<Actor> {
    const added = await addUserWithToken(t.ctx, login, {
      instanceAdmin: opts?.instanceAdmin,
    });
    return { id: added.user.id, login, headers: added.headers };
  }

  async function machineOf(owner: Actor, login: string): Promise<Actor> {
    const added = await addUserWithToken(t.ctx, login, {
      kind: "machine",
      ownerId: owner.id,
    });
    return { id: added.user.id, login, headers: added.headers };
  }

  /** A fresh project per test, so one test's rows never decide another's. */
  async function project(creator: Actor): Promise<string> {
    const slug = `mem-${seq++}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: sending(creator.headers),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
    return slug;
  }

  const setRole = (who: Actor, slug: string, userId: number, role: string) =>
    t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: sending(who.headers),
      body: JSON.stringify({ role }),
    });

  const removeRole = (who: Actor, slug: string, userId: number) =>
    t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "DELETE",
      headers: who.headers,
    });

  const addByLogin = (who: Actor, slug: string, login: string, role: string) =>
    t.app.request(`/api/projects/${slug}/members`, {
      method: "POST",
      headers: sending(who.headers),
      body: JSON.stringify({ login, role }),
    });

  async function members(who: Actor, slug: string) {
    const res = await t.app.request(`/api/projects/${slug}/members`, {
      headers: who.headers,
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  /** login → role, which is what an assertion about "who is in here" means. */
  async function rolesIn(
    who: Actor,
    slug: string,
  ): Promise<Record<string, string>> {
    const rows = await members(who, slug);
    return Object.fromEntries(
      rows.map((m: { user: { login: string }; role: string }) => [
        m.user.login,
        m.role,
      ]),
    );
  }

  const roleOf = async (who: Actor, slug: string, login: string) =>
    (await rolesIn(who, slug))[login];

  /**
   * A machine row whose owner holds nothing here. Written straight into the
   * table because the API cannot produce one: putting it there needs a
   * ceiling, and removing the owner takes the machine with them. What does
   * produce one is an owner whose instance-admin flag was later cleared, and
   * rows predating the ceiling — both of which the page still has to render.
   */
  async function seedOrphan(slug: string, userId: number): Promise<void> {
    const found = await findProjectByRef(t.ctx, slug);
    if (!found) throw new Error(`no project ${slug}`);
    await t.ctx.router.system().insert(projectMembers).values({
      projectId: found.project.id,
      userId,
      role: "writer",
    });
  }

  const ok = async (res: Response) => {
    expect(res.status).toBe(204);
    return res;
  };

  async function refused(res: Response, status: number, text: string) {
    expect(res.status).toBe(status);
    expect((await json(res)).error.message).toContain(text);
  }

  describe("the ceiling", () => {
    it("refuses a machine a role above its owner's", async () => {
      const alice = await human("ceil-alice");
      const bob = await human("ceil-bob");
      const bot = await machineOf(bob, "ceil-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "reporter"));

      await refused(
        await setRole(alice, slug, bot.id, "writer"),
        409,
        "cannot outrank its owner",
      );
      // The owner's own level is fine, and so is anything under it.
      await ok(await setRole(alice, slug, bot.id, "reporter"));
      await ok(await setRole(alice, slug, bot.id, "reader"));
    });

    it("binds an admin too — there is no exemption for the person asking", async () => {
      const alice = await human("ceil2-alice");
      const bob = await human("ceil2-bob");
      const bot = await machineOf(bob, "ceil2-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "reader"));

      await refused(
        await setRole(alice, slug, bot.id, "admin"),
        409,
        "cannot outrank its owner",
      );
    });

    it("refuses a machine whose owner is not here, naming the owner", async () => {
      const alice = await human("ceil3-alice");
      const bob = await human("ceil3-bob");
      const bot = await machineOf(bob, "ceil3-bot");
      const slug = await project(alice);

      await refused(
        await setRole(alice, slug, bot.id, "reader"),
        409,
        "@ceil3-bob",
      );
    });

    it("lets an instance admin's machine in, all the way to admin", async () => {
      const alice = await human("ceil4-alice");
      const root = await human("ceil4-root", { instanceAdmin: true });
      const bot = await machineOf(root, "ceil4-bot");
      const slug = await project(alice);

      // The owner holds no membership row anywhere; the ceiling still has to
      // come out as admin, because that is their effective role here.
      await ok(await setRole(alice, slug, bot.id, "admin"));
      expect(await roleOf(alice, slug, "ceil4-bot")).toBe("admin");
    });

    it("reports the owner's ceiling on the list, and null for a human", async () => {
      const alice = await human("ceil5-alice");
      const bob = await human("ceil5-bob");
      const bot = await machineOf(bob, "ceil5-bot");
      const orphan = await machineOf(
        await human("ceil5-gone"),
        "ceil5-orphan-bot",
      );
      const root = await human("ceil5-root", { instanceAdmin: true });
      const rootBot = await machineOf(root, "ceil5-root-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "writer"));
      await ok(await setRole(alice, slug, bot.id, "reader"));
      await ok(await setRole(alice, slug, rootBot.id, "reader"));
      await seedOrphan(slug, orphan.id);

      const rows = await members(alice, slug);
      const ceiling = Object.fromEntries(
        rows.map(
          (m: { user: { login: string }; owner_role: string | null }) => [
            m.user.login,
            m.owner_role,
          ],
        ),
      );

      expect(ceiling["ceil5-alice"]).toBe(null);
      expect(ceiling["ceil5-bot"]).toBe("writer");
      // No ceiling at all, which is what puts this row in its own block.
      expect(ceiling["ceil5-orphan-bot"]).toBe(null);
      // An instance admin owner reads as admin, not as "not a member" — that
      // is the whole difference between the main list and the orphan block.
      expect(ceiling["ceil5-root-bot"]).toBe("admin");
    });
  });

  describe("collateral on the owner's own row", () => {
    it("clamps the machines a demotion leaves above their owner", async () => {
      const alice = await human("clamp-alice");
      const bob = await human("clamp-bob");
      const high = await machineOf(bob, "clamp-high-bot");
      const low = await machineOf(bob, "clamp-low-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "admin"));
      await ok(await setRole(alice, slug, high.id, "admin"));
      await ok(await setRole(alice, slug, low.id, "reader"));

      // Proved before the clamp, not after: were the machine already at the
      // target role, the assertion below would pass without a clamp ever
      // having run.
      expect(await roleOf(alice, slug, "clamp-high-bot")).toBe("admin");

      await ok(await setRole(alice, slug, bob.id, "reporter"));

      expect(await rolesIn(alice, slug)).toMatchObject({
        "clamp-bob": "reporter",
        "clamp-high-bot": "reporter",
        // Already under the new ceiling, so untouched — the clamp is a
        // ceiling, not an assignment.
        "clamp-low-bot": "reader",
      });
    });

    it("leaves the machines alone when the owner goes up", async () => {
      const alice = await human("up-alice");
      const bob = await human("up-bob");
      const bot = await machineOf(bob, "up-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "reader"));
      await ok(await setRole(alice, slug, bot.id, "reader"));

      await ok(await setRole(alice, slug, bob.id, "admin"));

      // Raising a ceiling grants nothing by itself.
      expect(await roleOf(alice, slug, "up-bot")).toBe("reader");
    });

    it("takes the machines out with the owner", async () => {
      const alice = await human("evict-alice");
      const bob = await human("evict-bob");
      const bot = await machineOf(bob, "evict-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "writer"));
      await ok(await setRole(alice, slug, bot.id, "writer"));

      await ok(await removeRole(alice, slug, bob.id));

      // The row is gone, not merely a 204 away: the whole point is that the
      // machine does not stay behind with write access nobody can see.
      const left = await rolesIn(alice, slug);
      expect(Object.keys(left).sort()).toEqual(["evict-alice"]);
    });
  });

  describe("the last admin", () => {
    it("refuses a removal whose collateral would empty the admins", async () => {
      const alice = await human("last-alice");
      const bob = await human("last-bob");
      const bot = await machineOf(bob, "last-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "admin"));
      await ok(await setRole(alice, slug, bot.id, "admin"));
      // The creator's own admin row has to go first, or there are three
      // admins here and the hole is never stepped on. Bob does the removing:
      // alice removing herself is SELF_MEMBERSHIP, a different refusal.
      await ok(await removeRole(bob, slug, alice.id));

      await refused(
        await removeRole(bot, slug, bob.id),
        409,
        "no admin at all",
      );
      expect(await rolesIn(bob, slug)).toEqual({
        "last-bob": "admin",
        "last-bot": "admin",
      });
    });

    it("refuses a demotion whose collateral would empty the admins", async () => {
      const alice = await human("last2-alice");
      const bob = await human("last2-bob");
      const bot = await machineOf(bob, "last2-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "admin"));
      await ok(await setRole(alice, slug, bot.id, "admin"));
      await ok(await removeRole(bob, slug, alice.id));

      await refused(
        await setRole(bot, slug, bob.id, "writer"),
        409,
        "no admin at all",
      );
      expect(await rolesIn(bob, slug)).toEqual({
        "last2-bob": "admin",
        "last2-bot": "admin",
      });
    });

    it("allows it once somebody else holds admin", async () => {
      const alice = await human("last3-alice");
      const bob = await human("last3-bob");
      const bot = await machineOf(bob, "last3-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "admin"));
      await ok(await setRole(alice, slug, bot.id, "admin"));

      // Alice is the third admin, so bob and his machine may both go.
      await ok(await removeRole(alice, slug, bob.id));
      expect(await rolesIn(alice, slug)).toEqual({ "last3-alice": "admin" });
    });
  });

  describe("who may write which row", () => {
    it("lets a reporter arrange their own machine without being an admin", async () => {
      const alice = await human("own-alice");
      const bob = await human("own-bob");
      const bot = await machineOf(bob, "own-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "reporter"));

      await ok(await setRole(bob, slug, bot.id, "reporter"));
      await ok(await removeRole(bob, slug, bot.id));
    });

    it("refuses that same reporter somebody else's machine", async () => {
      const alice = await human("other-alice");
      const bob = await human("other-bob");
      const carol = await human("other-carol");
      const hers = await machineOf(carol, "other-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "reporter"));
      await ok(await setRole(alice, slug, carol.id, "writer"));
      await ok(await setRole(alice, slug, hers.id, "reader"));

      // The message matters: a bare 403 would also be what a fixture that
      // never joined the project produces, and this has to be the other one
      // — bob is a member, just not an admin.
      await refused(
        await setRole(bob, slug, hers.id, "reader"),
        403,
        "member.set",
      );
      await refused(await removeRole(bob, slug, hers.id), 403, "member.remove");
    });

    it("still refuses anyone their own membership", async () => {
      const alice = await human("self-alice");
      const bob = await human("self-bob");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "admin"));

      await refused(
        await setRole(alice, slug, alice.id, "reader"),
        403,
        "your own membership",
      );
      await refused(
        await removeRole(alice, slug, alice.id),
        403,
        "your own membership",
      );
    });

    it("lets an orphan be removed but not re-roled", async () => {
      const alice = await human("orph-alice");
      const bob = await human("orph-bob");
      const bot = await machineOf(bob, "orph-bot");
      const slug = await project(alice);
      await seedOrphan(slug, bot.id);

      // The ceiling cannot be computed, so no role can be judged legal —
      // but the row is still a membership, and removing one never needed a
      // ceiling.
      await refused(
        await setRole(alice, slug, bot.id, "reader"),
        409,
        "@orph-bob",
      );
      await ok(await removeRole(alice, slug, bot.id));
      expect(await rolesIn(alice, slug)).toEqual({ "orph-alice": "admin" });
    });
  });

  describe("POST /projects/{slug}/members", () => {
    it("adds a person by their exact login", async () => {
      const alice = await human("post-alice");
      await human("post-newcomer");
      const slug = await project(alice);

      const res = await addByLogin(alice, slug, "post-newcomer", "reporter");

      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.user.login).toBe("post-newcomer");
      expect(body.role).toBe("reporter");
      expect(body.owner_role).toBe(null);
      expect(await roleOf(alice, slug, "post-newcomer")).toBe("reporter");
    });

    it("answers an unknown login with a flat 404", async () => {
      const alice = await human("post2-alice");
      const slug = await project(alice);

      await refused(
        await addByLogin(alice, slug, "nobody-at-all", "reader"),
        404,
        "no such user",
      );
    });

    it("refuses an existing member rather than rewriting their role", async () => {
      const alice = await human("post3-alice");
      const bob = await human("post3-bob");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "admin"));

      await refused(
        await addByLogin(alice, slug, "post3-bob", "reader"),
        409,
        "already a member",
      );
      expect(await roleOf(alice, slug, "post3-bob")).toBe("admin");
    });

    it("holds a machine login to the same ceiling", async () => {
      const alice = await human("post4-alice");
      const bob = await human("post4-bob");
      await machineOf(bob, "post4-bot");
      const slug = await project(alice);
      await ok(await setRole(alice, slug, bob.id, "reporter"));

      await refused(
        await addByLogin(alice, slug, "post4-bot", "writer"),
        409,
        "cannot outrank its owner",
      );
      const added = await addByLogin(alice, slug, "post4-bot", "reporter");
      expect(added.status).toBe(201);
      expect((await json(added)).owner_role).toBe("reporter");
    });

    it("turns a non-member away before the login is looked at", async () => {
      const alice = await human("post5-alice");
      const stranger = await human("post5-stranger");
      const slug = await project(alice);

      // A login that certainly does not exist: if the lookup ran first the
      // answer would be `no such user`, and this endpoint would be a
      // login-existence probe open to anyone. Both refusals are 404, so only
      // the body tells them apart.
      await refused(
        await addByLogin(stranger, slug, "definitely-not-a-user", "reader"),
        404,
        "project not found",
      );
    });
  });
});
