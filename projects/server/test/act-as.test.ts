import {
  ACT_AS_HEADER,
  type CliAuthTarget,
  type TokenScope,
} from "@todou/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../src/db/system-schema.ts";
import { issueToken } from "../src/services/tokens.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const FORWARD_TOML = [
  "[auth]",
  'mode = "forward"',
  "[auth.forward]",
  'user_header = "Remote-User"',
].join("\n");

type Headers = Record<string, string>;

/**
 * A human's token sent with x-todou-act-as runs as the named agent (T-693).
 * Fixture: alice owns bot-one; both are writers in "bots", only alice is a
 * member of "owners". The reverse fixture — an agent in a project its owner
 * is not in — cannot exist, because an agent's role is capped by its owner's.
 */
describe("x-todou-act-as", () => {
  let t: TestApp;
  let cookie: string;
  let aliceId: number;
  let botId: number;
  /** Alice's tokens: no scopes, agents:act, and agents:act + agents:create. */
  let off: Headers;
  let existing: Headers;
  let create: Headers;
  let botToken: Headers;

  const as = (base: Headers, login: string): Headers => ({
    ...base,
    [ACT_AS_HEADER]: login,
  });
  const me = (headers: Headers) => t.app.request("/api/me", { headers });
  const expect401 = async (res: Response, message: string) => {
    expect(res.status).toBe(401);
    expect((await json(res)).error.message).toBe(message);
  };

  const addMember = async (slug: string, userId: number) => {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "writer" }),
    });
    expect(res.status).toBe(204);
  };

  const project = async (slug: string) => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
    const issue = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "first" }),
    });
    expect(issue.status).toBe(201);
  };

  const agentRow = async (login: string) =>
    (
      await t.ctx.router
        .system()
        .select()
        .from(users)
        .where(eq(users.login, login))
    )[0];

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const alice = await addUserWithToken(t.ctx, "alice");
    aliceId = alice.user.id;
    off = alice.headers;
    const issue = async (name: string, scopes: TokenScope[]) => {
      const token = await issueToken(t.ctx.router.system(), aliceId, {
        name,
        scopes,
      });
      return { authorization: `Bearer ${token.token}` };
    };
    existing = await issue("existing", ["agents:act"]);
    create = await issue("create", ["agents:act", "agents:create"]);
    const bot = await addUserWithToken(t.ctx, "bot-one", {
      kind: "machine",
      ownerId: aliceId,
      // Unreachable through the API; set here to prove the middleware
      // refuses an agent's token on its own.
      scopes: ["agents:act"],
    });
    botId = bot.user.id;
    botToken = bot.headers;
    await project("bots");
    await project("owners");
    await addMember("bots", aliceId);
    await addMember("bots", botId);
    await addMember("owners", aliceId);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("runs the request as the agent, with the agent's permissions", async () => {
    const who = await json(await me(as(existing, "bot-one")));
    expect(who.login).toBe("bot-one");

    const read = await t.app.request("/api/projects/bots/issues/1", {
      headers: as(existing, "bot-one"),
    });
    expect(read.status).toBe(200);
    const write = await t.app.request("/api/projects/bots/issues/1/comments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...as(existing, "bot-one"),
      },
      body: JSON.stringify({ body: "from the bot" }),
    });
    expect(write.status).toBe(201);
    expect((await json(write)).author.login).toBe("bot-one");

    // Alice can read "owners"; the agent cannot, and acting as it is not
    // the union of the two. A project a caller cannot read is a 404 here.
    expect(
      (
        await t.app.request("/api/projects/owners/issues/1", {
          headers: off,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.app.request("/api/projects/owners/issues/1", {
          headers: as(existing, "bot-one"),
        })
      ).status,
    ).toBe(404);
  });

  it("lets an instance admin act as somebody else's agent", async () => {
    const root = await addUserWithToken(t.ctx, "root", {
      instanceAdmin: true,
      scopes: ["agents:act"],
    });
    expect((await json(await me(as(root.headers, "bot-one")))).login).toBe(
      "bot-one",
    );
  });

  it("creates a missing agent once, owned by the holder", async () => {
    const first = await json(await me(as(create, "fresh-bot")));
    expect(first.login).toBe("fresh-bot");
    const row = await agentRow("fresh-bot");
    expect(row?.kind).toBe("machine");
    expect(row?.ownerId).toBe(aliceId);
    expect(row?.displayName).toBe("fresh-bot");
    expect((await json(await me(as(create, "fresh-bot")))).id).toBe(first.id);
  });

  it("settles two concurrent creations of one login on a single row", async () => {
    const [a, b] = await Promise.all([
      me(as(create, "race-bot")),
      me(as(create, "race-bot")),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await json(a)).id).toBe((await json(b)).id);
    const rows = await t.ctx.router
      .system()
      .select()
      .from(users)
      .where(eq(users.login, "race-bot"));
    expect(rows).toHaveLength(1);
  });

  it("trims the value but matches the login exactly", async () => {
    expect((await json(await me(as(existing, "  bot-one ")))).login).toBe(
      "bot-one",
    );
    await expect401(
      await me(as(existing, String(botId))),
      `no agent "${botId}" this token can act as`,
    );
  });

  describe("refusals", () => {
    let eveBot: string;
    let disabled: string;

    beforeAll(async () => {
      const eve = await addUserWithToken(t.ctx, "eve");
      eveBot = (
        await addUserWithToken(t.ctx, "eve-bot", {
          kind: "machine",
          ownerId: eve.user.id,
        })
      ).user.login;
      const old = await addUserWithToken(t.ctx, "old-bot", {
        kind: "machine",
        ownerId: aliceId,
      });
      disabled = old.user.login;
      await t.ctx.router
        .system()
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, old.user.id));
    });

    it("refuses a blank value", async () => {
      await expect401(await me(as(existing, "  ")), "x-todou-act-as is empty");
    });

    it("refuses the header on a cookie session", async () => {
      await expect401(
        await me({ cookie, [ACT_AS_HEADER]: "bot-one" }),
        "x-todou-act-as requires token authentication",
      );
    });

    it("refuses the header in forward mode", async () => {
      const fwd = await makeTestApp("shared", { extraToml: FORWARD_TOML });
      try {
        // An untrusted peer too: the refusal depends on the request alone.
        await expect401(
          await fwd.app.request(
            "/api/me",
            { headers: { "Remote-User": "alice", [ACT_AS_HEADER]: "bot-one" } },
            { incoming: { socket: { remoteAddress: "203.0.113.9" } } },
          ),
          "x-todou-act-as requires token authentication",
        );
      } finally {
        await fwd.cleanup();
      }
    });

    it("refuses a token issued without agents:act", async () => {
      await expect401(
        await me(as(off, "bot-one")),
        "this token cannot act as an agent",
      );
    });

    it("refuses an agent's token, even naming itself", async () => {
      await expect401(
        await me(as(botToken, "bot-one")),
        "this token cannot act as an agent",
      );
    });

    it("refuses a login that does not exist, for an existing-only token", async () => {
      await expect401(
        await me(as(existing, "nobody-bot")),
        'no agent "nobody-bot" this token can act as',
      );
      expect(await agentRow("nobody-bot")).toBeUndefined();
    });

    it("refuses a human login, someone else's agent, on either token", async () => {
      for (const token of [existing, create]) {
        await expect401(
          await me(as(token, "alice")),
          'no agent "alice" this token can act as',
        );
        await expect401(
          await me(as(token, eveBot)),
          `no agent "${eveBot}" this token can act as`,
        );
      }
    });

    it("refuses a disabled agent, saying so", async () => {
      await expect401(
        await me(as(existing, disabled)),
        `agent "${disabled}" is disabled`,
      );
    });

    it("refuses to create an invalid login", async () => {
      for (const login of ["12345", "me", "Upper-Bot"]) {
        await expect401(
          await me(as(create, login)),
          `"${login}" is not a valid agent login`,
        );
        expect(await agentRow(login)).toBeUndefined();
      }
    });

    it("reports an invalid token before looking at the header", async () => {
      await expect401(
        await me({
          authorization: "Bearer todou_pat_fallback",
          [ACT_AS_HEADER]: "bot-one",
        }),
        "invalid token",
      );
    });
  });

  describe("issuance", () => {
    const post = (path: string, headers: Headers, body: object) =>
      t.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const refusal = "agents cannot issue tokens; their owner issues them";

    it("never lets an agent issue itself a token", async () => {
      for (const headers of [botToken, as(existing, "bot-one")]) {
        for (const scopes of [[], ["agents:act"]]) {
          const res = await post("/api/me/tokens", headers, {
            name: "mine",
            scopes,
          });
          expect(res.status).toBe(403);
          expect((await json(res)).error.message).toBe(refusal);
        }
      }
    });

    it("never lets an agent approve a CLI login for itself", async () => {
      const created = await json(
        await post("/api/auth/cli/requests", {}, { name: "cli @ bot-one" }),
      );
      const target: CliAuthTarget = { kind: "me" };
      const res = await post(
        `/api/auth/cli/requests/${created.id}/approve`,
        as(existing, "bot-one"),
        { target },
      );
      expect(res.status).toBe(403);
      expect((await json(res)).error.message).toBe(refusal);
    });

    it("still lets an agent list and revoke its own tokens", async () => {
      const own = await issueToken(t.ctx.router.system(), botId, {
        name: "to-revoke",
      });
      const list = await t.app.request("/api/me/tokens", {
        headers: as(existing, "bot-one"),
      });
      expect(list.status).toBe(200);
      const names = (await json(list)).map((x: { name: string }) => x.name);
      expect(names).toContain("to-revoke");
      const del = await t.app.request(`/api/me/tokens/${own.id}`, {
        method: "DELETE",
        headers: as(existing, "bot-one"),
      });
      expect(del.status).toBe(204);
    });

    it("issues and lists scopes on a human's tokens", async () => {
      // Out of order and repeated: stored deduplicated, in TOKEN_SCOPES order.
      const issued = await post("/api/me/tokens", off, {
        name: "proxy",
        scopes: ["agents:create", "agents:act", "agents:create"],
      });
      expect(issued.status).toBe(201);
      const body = await json(issued);
      expect(body.scopes).toEqual(["agents:act", "agents:create"]);
      const defaulted = await json(
        await post("/api/me/tokens", off, { name: "plain" }),
      );
      expect(defaulted.scopes).toEqual([]);

      const list = await json(
        await t.app.request("/api/me/tokens", { headers: off }),
      );
      const byName = Object.fromEntries(
        list.map((x: { name: string; scopes: string[] }) => [x.name, x.scopes]),
      );
      expect(byName).toMatchObject({
        proxy: ["agents:act", "agents:create"],
        plain: [],
        existing: ["agents:act"],
      });
      // The token it just issued works for acting as an agent.
      const who = await me(
        as({ authorization: `Bearer ${body.token}` }, "bot-one"),
      );
      expect((await json(who)).login).toBe("bot-one");
    });

    it("refuses agents:create without agents:act", async () => {
      const res = await post("/api/me/tokens", off, {
        name: "half",
        scopes: ["agents:create"],
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.message).toBe(
        "agents:create requires agents:act",
      );
    });

    it("refuses scopes on an agent's token", async () => {
      const refused = await post(`/api/agents/${botId}/tokens`, off, {
        name: "agent",
        scopes: ["agents:act"],
      });
      expect(refused.status).toBe(422);
      const issued = await post(`/api/agents/${botId}/tokens`, off, {
        name: "agent",
        scopes: [],
      });
      expect(issued.status).toBe(201);
      expect((await json(issued)).scopes).toEqual([]);
      const list = await json(
        await t.app.request(`/api/agents/${botId}/tokens`, { headers: off }),
      );
      const byName = Object.fromEntries(
        list.map((x: { name: string; scopes: string[] }) => [x.name, x.scopes]),
      );
      // bot-one-token was written past the API by the fixture.
      expect(byName).toMatchObject({
        agent: [],
        "bot-one-token": ["agents:act"],
      });
    });
  });

  it("forwards the header to every batch sub-request", async () => {
    const res = await t.app.request("/api/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...as(existing, "bot-one"),
      },
      body: JSON.stringify({
        requests: [{ url: "/me" }, { url: "/projects/bots/issues/1" }],
      }),
    });
    expect(res.status).toBe(200);
    const { responses } = await json(res);
    expect(responses[0].body.login).toBe("bot-one");
    expect(responses[1].status).toBe(200);
  });

  it("documents the header in the OpenAPI description", async () => {
    const doc = await json(await t.app.request("/api/openapi.json"));
    expect(doc.info.description).toContain("x-todou-act-as");
  });
});
