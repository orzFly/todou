import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("agents (machine users)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createAgent(login: string) {
    const res = await t.app.request("/api/agents", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ login, display_name: `Agent ${login}` }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function issueToken(agentId: number) {
    const res = await t.app.request(`/api/agents/${agentId}/tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "work" }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  it("creates an owned machine user", async () => {
    const agent = await createAgent("muelsyse-bot");
    expect(agent.kind).toBe("machine");
    expect(agent.owner.login).toBe("user");
    expect(agent.disabled_at).toBeNull();
  });

  it("409s on login conflicts", async () => {
    await createAgent("dup-bot");
    const res = await t.app.request("/api/agents", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ login: "dup-bot", display_name: "again" }),
    });
    expect(res.status).toBe(409);
  });

  it("lets an agent act end-to-end via PAT: member, issue, comment", async () => {
    const agent = await createAgent("worker-bot");
    const token = await issueToken(agent.id);
    const agentHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${token.token}`,
    };

    // Agent identity resolves with owner attached.
    const me = await json(
      await t.app.request("/api/me", { headers: agentHeaders }),
    );
    expect(me.kind).toBe("machine");
    expect(me.owner.login).toBe("user");

    // Human creates a project and adds the agent as writer.
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: "bots", name: "Bot project" }),
    });
    const put = await t.app.request(`/api/projects/bots/members/${agent.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });
    expect(put.status).toBe(204);

    // Agent opens an issue and comments — the normal writer path.
    const issue = await json(
      await t.app.request("/api/projects/bots/issues", {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({ title: "bot filed this" }),
      }),
    );
    expect(issue.author.kind).toBe("machine");

    const comment = await json(
      await t.app.request(
        `/api/projects/bots/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: agentHeaders,
          body: JSON.stringify({ body: "beep boop, analysis attached" }),
        },
      ),
    );
    expect(comment.author.login).toBe("worker-bot");
  });

  it("machine users cannot create agents", async () => {
    const agent = await createAgent("no-recursion-bot");
    const token = await issueToken(agent.id);
    const res = await t.app.request("/api/agents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token.token}`,
      },
      body: JSON.stringify({ login: "sub-bot", display_name: "nope" }),
    });
    expect(res.status).toBe(403);
  });

  it("only the owner or instance admin manages an agent", async () => {
    const bob = await addUserWithToken(t.ctx, "bob-agent-owner");
    const bobHeaders = {
      "content-type": "application/json",
      ...bob.headers,
    };
    const created = await json(
      await t.app.request("/api/agents", {
        method: "POST",
        headers: bobHeaders,
        body: JSON.stringify({ login: "bobs-bot", display_name: "Bob's" }),
      }),
    );

    const carol = await addUserWithToken(t.ctx, "carol-stranger");
    const denied = await t.app.request(`/api/agents/${created.id}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...carol.headers },
      body: JSON.stringify({ name: "steal" }),
    });
    expect(denied.status).toBe(403);

    // The builtin user is instance admin and may manage Bob's agent.
    const adminIssue = await t.app.request(`/api/agents/${created.id}/tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "admin-issued" }),
    });
    expect(adminIssue.status).toBe(201);

    // owner=me scoping: bob sees his agent, carol sees none.
    const bobList = await json(
      await t.app.request("/api/agents", { headers: bob.headers }),
    );
    expect(bobList.map((a: { login: string }) => a.login)).toContain(
      "bobs-bot",
    );
    const carolList = await json(
      await t.app.request("/api/agents", { headers: carol.headers }),
    );
    expect(carolList).toHaveLength(0);
    // owner=all needs instance admin.
    const carolAll = await t.app.request("/api/agents?owner=all", {
      headers: carol.headers,
    });
    expect(carolAll.status).toBe(403);
  });

  it("disabling an agent revokes its tokens and blocks auth", async () => {
    const agent = await createAgent("doomed-bot");
    const token = await issueToken(agent.id);

    const disable = await t.app.request(`/api/agents/${agent.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(disable.status).toBe(204);

    const res = await t.app.request("/api/me", {
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(res.status).toBe(401);

    // Disabled agents cannot get fresh tokens.
    const reissue = await t.app.request(`/api/agents/${agent.id}/tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "reissue" }),
    });
    expect(reissue.status).toBe(409);
  });
});
