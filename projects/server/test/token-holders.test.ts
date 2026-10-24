import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

type Row = { id: number; name: string; holder: { id: number; login: string } };

// T-560: GET /me/tokens?holder=me|agents|all. Every account here holds one
// token from addUserWithToken, so a row's holder login names whose it is.
describe("token list by holder (T-560)", () => {
  let t: TestApp;
  type Account = Awaited<ReturnType<typeof addUserWithToken>>;
  let alice: Account;
  let aliceBot: Account;
  let aliceHelper: Account;
  let bob: Account;
  let bobBot: Account;
  let admin: Account;

  beforeAll(async () => {
    t = await makeTestApp();
    const add = (
      login: string,
      opts?: Parameters<typeof addUserWithToken>[2],
    ) => addUserWithToken(t.ctx, login, opts);
    alice = await add("alice");
    aliceBot = await add("alice-bot", {
      kind: "machine",
      ownerId: alice.user.id,
    });
    aliceHelper = await add("alice-helper", {
      kind: "machine",
      ownerId: alice.user.id,
    });
    bob = await add("bob");
    bobBot = await add("bob-bot", { kind: "machine", ownerId: bob.user.id });
    admin = await add("root", { instanceAdmin: true });
    await add("root-bot", { kind: "machine", ownerId: admin.user.id });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function list(who: Account, query = ""): Promise<Row[]> {
    const res = await t.app.request(`/api/me/tokens${query}`, {
      headers: who.headers,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Row[];
  }
  const holders = (rows: Row[]) => rows.map((r) => r.holder.login).sort();

  it("defaults to the caller's own tokens, each carrying its holder", async () => {
    const rows = await list(alice);
    expect(holders(rows)).toEqual(["alice"]);
    expect(rows[0]?.holder.id).toBe(alice.user.id);
    expect(await list(alice, "?holder=me")).toEqual(rows);
  });

  it("agents lists exactly the agents the caller owns", async () => {
    expect(holders(await list(alice, "?holder=agents"))).toEqual([
      "alice-bot",
      "alice-helper",
    ]);
    expect(holders(await list(bob, "?holder=agents"))).toEqual(["bob-bot"]);
  });

  it("all is the caller plus their agents, oldest token first", async () => {
    const rows = await list(alice, "?holder=all");
    expect(holders(rows)).toEqual(["alice", "alice-bot", "alice-helper"]);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("an instance admin sees only agents they own, not everyone's", async () => {
    expect(holders(await list(admin, "?holder=all"))).toEqual([
      "root",
      "root-bot",
    ]);
  });

  it("an agent has no agents of its own", async () => {
    expect(await list(aliceBot, "?holder=agents")).toEqual([]);
    expect(holders(await list(aliceBot, "?holder=all"))).toEqual(["alice-bot"]);
  });

  it("rejects an unknown holder instead of falling back to me", async () => {
    const res = await t.app.request("/api/me/tokens?holder=everyone", {
      headers: alice.headers,
    });
    expect(res.status).toBe(422);
  });

  // The Personal tokens page issues and revokes an agent's token through the
  // agent endpoints; this is the owner check it relies on.
  it("another human cannot issue or revoke for an agent they do not own", async () => {
    const [aliceBotToken] = await list(alice, "?holder=agents");
    expect(aliceBotToken?.holder.login).toBe("alice-bot");

    const revoke = await t.app.request(
      `/api/agents/${aliceBot.user.id}/tokens/${aliceBotToken?.id}`,
      { method: "DELETE", headers: bob.headers },
    );
    expect(revoke.status).toBe(403);
    const issue = await t.app.request(
      `/api/agents/${aliceBot.user.id}/tokens`,
      {
        method: "POST",
        headers: { ...bob.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "stolen" }),
      },
    );
    expect(issue.status).toBe(403);

    expect((await list(alice, "?holder=agents")).map((r) => r.id)).toContain(
      aliceBotToken?.id,
    );
  });

  it("drops revoked tokens and a disabled agent's tokens", async () => {
    const issued = await t.app.request(
      `/api/agents/${aliceHelper.user.id}/tokens`,
      {
        method: "POST",
        headers: { ...alice.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "second" }),
      },
    );
    expect(issued.status).toBe(201);
    const second = (await issued.json()) as { id: number };
    expect((await list(alice, "?holder=agents")).map((r) => r.name)).toContain(
      "second",
    );

    const revoked = await t.app.request(
      `/api/agents/${aliceHelper.user.id}/tokens/${second.id}`,
      { method: "DELETE", headers: alice.headers },
    );
    expect(revoked.status).toBe(204);
    expect(
      (await list(alice, "?holder=agents")).map((r) => r.name),
    ).not.toContain("second");

    const disabled = await t.app.request(`/api/agents/${aliceHelper.user.id}`, {
      method: "DELETE",
      headers: alice.headers,
    });
    expect(disabled.status).toBe(204);
    expect(holders(await list(alice, "?holder=agents"))).toEqual(["alice-bot"]);
  });

  it("the per-agent list carries the agent as holder", async () => {
    const res = await t.app.request(`/api/agents/${bobBot.user.id}/tokens`, {
      headers: bob.headers,
    });
    expect(res.status).toBe(200);
    expect(holders((await res.json()) as Row[])).toEqual(["bob-bot"]);
  });
});
