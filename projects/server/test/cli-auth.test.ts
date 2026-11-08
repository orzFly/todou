import type { CliAuthTarget } from "@todou/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAT_PREFIX } from "../src/auth/pat.ts";
import { cliAuthRequests, tokens, users } from "../src/db/system-schema.ts";
import {
  CLI_AUTH_CREATE_LIMIT,
  CLI_AUTH_CREATE_WINDOW_MS,
} from "../src/routes/cli-auth.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

let t: TestApp;

beforeAll(async () => {
  t = await makeTestApp();
});

afterAll(async () => {
  await t.cleanup();
});

const jsonHeaders = { "content-type": "application/json" };

async function createRequest(name = "cli @ bot-one") {
  const res = await t.app.request("/api/auth/cli/requests", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return json(res);
}

/** As a node server would see it: the TCP peer lives in the adapter env. */
function createFrom(peer: string, headers: Record<string, string> = {}) {
  return t.app.request(
    "/api/auth/cli/requests",
    {
      method: "POST",
      headers: { ...jsonHeaders, ...headers },
      body: JSON.stringify({ name: "cli @ elsewhere" }),
    },
    { incoming: { socket: { remoteAddress: peer } } },
  );
}

function poll(id: number, secret: string) {
  return t.app.request(`/api/auth/cli/requests/${id}/poll`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ poll_secret: secret }),
  });
}

function approve(id: number, target: CliAuthTarget, cookie?: string) {
  return t.app.request(`/api/auth/cli/requests/${id}/approve`, {
    method: "POST",
    headers: cookie ? { ...jsonHeaders, cookie } : jsonHeaders,
    body: JSON.stringify({ target }),
  });
}

function deny(id: number, cookie?: string) {
  return t.app.request(`/api/auth/cli/requests/${id}/deny`, {
    method: "POST",
    headers: cookie ? { cookie } : undefined,
  });
}

function byCode(code: string, cookie?: string) {
  return t.app.request(`/api/auth/cli/requests/by-code/${code}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

/** Reach past the API to age a request out, as 15 minutes of waiting would. */
async function expire(id: number) {
  await t.ctx.router
    .system()
    .update(cliAuthRequests)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(cliAuthRequests.id, id));
}

async function createAgent(cookie: string, login: string) {
  const res = await t.app.request("/api/agents", {
    method: "POST",
    headers: { ...jsonHeaders, cookie },
    body: JSON.stringify({ login, display_name: login }),
  });
  expect(res.status).toBe(201);
  return json(res);
}

describe("cli device authorization", () => {
  it("runs create → pending → approve → collect once", async () => {
    const cookie = await t.login();
    const created = await createRequest();
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(created.interval).toBeGreaterThan(0);
    expect(created.expires_in).toBe(900);

    expect(await json(await poll(created.id, created.poll_secret))).toEqual({
      status: "pending",
    });

    const info = await json(await byCode(created.code, cookie));
    expect(info).toMatchObject({ id: created.id, name: "cli @ bot-one" });

    const approved = await approve(created.id, { kind: "me" }, cookie);
    expect(approved.status).toBe(200);
    expect(await json(approved)).toEqual({ agent_id: null });

    const collected = await json(await poll(created.id, created.poll_secret));
    expect(collected.status).toBe("approved");
    expect(collected.token.startsWith(PAT_PREFIX)).toBe(true);

    const me = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${collected.token}` },
    });
    expect(me.status).toBe(200);
    expect((await json(me)).login).toBe("user");

    // The row is gone with the outcome: a second poll cannot mint again.
    expect((await poll(created.id, created.poll_secret)).status).toBe(404);
  });

  it("reports a denial once, then forgets the request", async () => {
    const cookie = await t.login();
    const created = await createRequest();
    expect((await deny(created.id, cookie)).status).toBe(204);

    expect(await json(await poll(created.id, created.poll_secret))).toEqual({
      status: "denied",
    });
    expect((await poll(created.id, created.poll_secret)).status).toBe(404);
  });

  it("404s a wrong poll secret and an unknown id alike", async () => {
    const created = await createRequest();
    expect((await poll(created.id, "not-the-secret")).status).toBe(404);
    expect((await poll(created.id + 100_000, created.poll_secret)).status).toBe(
      404,
    );
    // The wrong secret consumed nothing: the real one still works.
    expect(await json(await poll(created.id, created.poll_secret))).toEqual({
      status: "pending",
    });
  });

  it("treats an expired request as absent everywhere", async () => {
    const cookie = await t.login();
    const created = await createRequest();
    await expire(created.id);

    expect((await poll(created.id, created.poll_secret)).status).toBe(404);
    expect((await byCode(created.code, cookie)).status).toBe(404);
    expect((await approve(created.id, { kind: "me" }, cookie)).status).toBe(
      404,
    );
    expect((await deny(created.id, cookie)).status).toBe(404);
  });

  it("409s a second verdict on the same request", async () => {
    const cookie = await t.login();
    const first = await createRequest();
    expect((await approve(first.id, { kind: "me" }, cookie)).status).toBe(200);
    expect((await approve(first.id, { kind: "me" }, cookie)).status).toBe(409);
    expect((await deny(first.id, cookie)).status).toBe(409);

    const second = await createRequest();
    expect((await deny(second.id, cookie)).status).toBe(204);
    expect((await approve(second.id, { kind: "me" }, cookie)).status).toBe(409);
  });

  it("hides a request once it is no longer pending", async () => {
    const cookie = await t.login();
    const created = await createRequest();
    expect((await deny(created.id, cookie)).status).toBe(204);
    expect((await byCode(created.code, cookie)).status).toBe(404);
  });

  it("accepts the code in its display spelling", async () => {
    const cookie = await t.login();
    const created = await createRequest();
    const dashed = `${created.code.slice(0, 4)}-${created.code.slice(4)}`;
    const res = await byCode(dashed.toLowerCase(), cookie);
    expect(res.status).toBe(200);
    expect((await json(res)).code).toBe(created.code);
  });

  it("mints for a brand-new agent created at approval time", async () => {
    const cookie = await t.login();
    const created = await createRequest("cli @ newcomer");
    const approved = await approve(
      created.id,
      { kind: "new", login: "newcomer" },
      cookie,
    );
    expect(approved.status).toBe(200);
    const agentId = (await json(approved)).agent_id;
    expect(agentId).toBeGreaterThan(0);

    const collected = await json(await poll(created.id, created.poll_secret));
    const me = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${collected.token}` },
    });
    expect(await json(me)).toMatchObject({ id: agentId, login: "newcomer" });
  });

  it("passes a login clash through unchanged and leaves the request usable", async () => {
    const cookie = await t.login();
    await createAgent(cookie, "taken-bot");
    const created = await createRequest();
    const clash = await approve(
      created.id,
      { kind: "new", login: "taken-bot" },
      cookie,
    );
    expect(clash.status).toBe(409);
    expect((await json(clash)).error.message).toContain("already taken");

    // A refused target must not have consumed the request.
    expect((await approve(created.id, { kind: "me" }, cookie)).status).toBe(
      200,
    );
  });

  it("refuses a disabled agent the way the token endpoint does", async () => {
    const cookie = await t.login();
    const agent = await createAgent(cookie, "retired-bot");
    expect(
      (
        await t.app.request(`/api/agents/${agent.id}`, {
          method: "DELETE",
          headers: { cookie },
        })
      ).status,
    ).toBe(204);

    const created = await createRequest();
    const res = await approve(
      created.id,
      { kind: "agent", id: agent.id },
      cookie,
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toContain("disabled");
  });

  it("keeps an approval voided by a disable voided after re-enabling", async () => {
    const cookie = await t.login();
    const agent = await createAgent(cookie, "paused-bot");
    const created = await createRequest();
    expect(
      (await approve(created.id, { kind: "agent", id: agent.id }, cookie))
        .status,
    ).toBe(200);
    expect(
      (
        await t.app.request(`/api/agents/${agent.id}`, {
          method: "DELETE",
          headers: { cookie },
        })
      ).status,
    ).toBe(204);
    const enabled = await t.app.request(`/api/agents/${agent.id}/enable`, {
      method: "POST",
      headers: { cookie },
    });
    expect(enabled.status).toBe(200);

    // Collected only now, with the agent enabled again: the disable has to
    // have voided the approval itself, not merely blocked collection.
    expect(await json(await poll(created.id, created.poll_secret))).toEqual({
      status: "denied",
    });
    expect((await poll(created.id, created.poll_secret)).status).toBe(404);

    // A fresh login after re-enabling is the way back, and it still works.
    const again = await createRequest();
    await approve(again.id, { kind: "agent", id: agent.id }, cookie);
    const collected = await json(await poll(again.id, again.poll_secret));
    const me = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${collected.token}` },
    });
    expect((await json(me)).login).toBe("paused-bot");
  });

  it("voids an approval collected after the agent was disabled, even if the row survived", async () => {
    const cookie = await t.login();
    const agent = await createAgent(cookie, "racing-bot");
    const created = await createRequest();
    await approve(created.id, { kind: "agent", id: agent.id }, cookie);
    // Disable without the route's request sweep, as a disable racing the
    // poll would leave things: the row still approved, the agent disabled.
    await t.ctx.router
      .system()
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, agent.id));

    expect(await json(await poll(created.id, created.poll_secret))).toEqual({
      status: "denied",
    });
    const live = await t.ctx.router
      .system()
      .select()
      .from(tokens)
      .where(and(eq(tokens.userId, agent.id), isNull(tokens.revokedAt)));
    expect(live).toEqual([]);
  });

  it("mints for an agent the approver owns", async () => {
    const cookie = await t.login();
    const agent = await createAgent(cookie, "worker-bot");
    const created = await createRequest();
    const approved = await approve(
      created.id,
      { kind: "agent", id: agent.id },
      cookie,
    );
    expect(await json(approved)).toEqual({ agent_id: agent.id });

    const collected = await json(await poll(created.id, created.poll_secret));
    const me = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${collected.token}` },
    });
    expect((await json(me)).login).toBe("worker-bot");
  });

  it("guards the browser half and leaves the CLI half public", async () => {
    const created = await createRequest();
    expect((await poll(created.id, created.poll_secret)).status).toBe(200);
    expect((await byCode(created.code)).status).toBe(401);
    expect((await approve(created.id, { kind: "me" })).status).toBe(401);
    expect((await deny(created.id)).status).toBe(401);
  });

  it("sweeps expired requests out when the next one is created", async () => {
    const stale = await createRequest();
    await expire(stale.id);
    await createRequest();

    const rows = await t.ctx.router
      .system()
      .select()
      .from(cliAuthRequests)
      .where(eq(cliAuthRequests.id, stale.id));
    expect(rows).toEqual([]);
  });

  it("shows the approver where the request came from", async () => {
    const cookie = await t.login();
    const direct = await json(
      await createFrom("203.0.113.7", { "user-agent": "todou-cli/0.6.7" }),
    );
    expect(await json(await byCode(direct.code, cookie))).toMatchObject({
      requester_ip: "203.0.113.7",
      requester_user_agent: "todou-cli/0.6.7",
    });

    // Behind a trusted proxy the forwarded client counts; a hop the client
    // wrote itself, further left, does not.
    const proxied = await json(
      await createFrom("127.0.0.1", {
        "x-forwarded-for": "192.0.2.66, 198.51.100.9",
      }),
    );
    expect(await json(await byCode(proxied.code, cookie))).toMatchObject({
      requester_ip: "198.51.100.9",
      requester_user_agent: null,
    });

    // From an untrusted peer the header is the client's own claim.
    const spoofed = await json(
      await createFrom("203.0.113.8", { "x-forwarded-for": "198.51.100.10" }),
    );
    expect((await json(await byCode(spoofed.code, cookie))).requester_ip).toBe(
      "203.0.113.8",
    );
  });

  it("caps how many requests one address may start", async () => {
    for (let i = 0; i < CLI_AUTH_CREATE_LIMIT; i++) {
      expect((await createFrom("203.0.113.20")).status).toBe(201);
    }
    const refused = await createFrom("203.0.113.20");
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(CLI_AUTH_CREATE_WINDOW_MS / 1000);
    expect((await json(refused)).error).toMatchObject({
      code: "rate_limited",
      details: { retry_after: retryAfter },
    });

    // Somebody else's login is not caught up in it.
    expect((await createFrom("203.0.113.21")).status).toBe(201);
  });

  it("counts an IPv6 client's whole /64 as one address", async () => {
    for (let i = 0; i < CLI_AUTH_CREATE_LIMIT; i++) {
      expect((await createFrom(`2001:db8:0:7::${i + 1}`)).status).toBe(201);
    }
    expect((await createFrom("2001:db8:0:7:ffff::9")).status).toBe(429);
    expect((await createFrom("2001:db8:0:8::1")).status).toBe(201);
  });

  it("sweeps expired requests through an index, not the whole table", async () => {
    const system = t.ctx.router.system();
    await system.execute(sql`set enable_seqscan = off`);
    try {
      const plan = await system.execute(
        sql`explain delete from cli_auth_requests where expires_at < now()`,
      );
      expect(JSON.stringify(plan)).toContain(
        "cli_auth_requests_expires_at_idx",
      );
    } finally {
      await system.execute(sql`reset enable_seqscan`);
    }
  });

  it("keeps the OpenAPI document generatable", async () => {
    const res = await t.app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = await json(res);
    expect(doc.paths["/api/auth/cli/requests"]).toBeDefined();
    expect(doc.paths["/api/auth/cli/requests/{id}/poll"]).toBeDefined();
  });
});
