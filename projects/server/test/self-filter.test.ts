import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The filter is pure SQL — `nullif`, `is distinct from`, a jsonb `->>` and
 * a parameter cast — so it runs against a real postgres too whenever
 * TODOU_TEST_POSTGRES_URL points at one (see timeline-postgres.test.ts for
 * the invocation). PGlite answering correctly says little about parameter
 * type inference on a real server.
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const BACKENDS: Array<[string, string | undefined]> = [
  ["pglite", undefined],
  ...(PG_URL ? [["postgres", PG_URL] as [string, string | undefined]] : []),
];

// Stand-ins for what a harness reports; real session ids never enter a
// fixture (AGENTS.md § Sanitization).
const SENTINEL = "session-sentinel";
const WORKER = "session-worker";

type Item = { type: string; body?: string; event_type?: string };
const keyOf = (i: Item) =>
  i.type === "comment" ? (i.body as string) : `event:${i.event_type}`;

describe.each(BACKENDS)("watch self-filter (%s)", (backend, systemUrl) => {
  let t: TestApp;
  let cookie: string;
  let meId = 0;
  let number = 0;
  let baseline = "";
  // A real postgres keeps its database between runs; the slug isolates one.
  const slug = `self-filter-${backend}-${Date.now().toString(36)}`;

  /** My headers, optionally claiming an agent session. */
  const mine = (session?: string) => ({
    "content-type": "application/json",
    cookie,
    ...(session === undefined
      ? {}
      : {
          "x-todou-agent-context": JSON.stringify({
            agent: "claude-code",
            session_id: session,
          }),
        }),
  });

  const keysOf = async (path: string, qs: string): Promise<string[]> => {
    const res = await t.app.request(`${path}?${qs}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await json(res)).items as Item[]).map(keyOf);
  };
  const timeline = (qs: string) =>
    keysOf(`/api/projects/${slug}/issues/${number}/timeline`, qs);
  const activity = (qs: string) => keysOf(`/api/projects/${slug}/activity`, qs);
  const cross = (qs: string) =>
    keysOf("/api/activity", `projects=${slug}&${qs}`);

  beforeAll(async () => {
    t = await makeTestApp("shared", systemUrl ? { systemUrl } : undefined);
    cookie = await t.login();
    meId = (await json(await t.app.request("/api/me", { headers: { cookie } })))
      .id as number;
    expect(
      (
        await t.app.request("/api/projects", {
          method: "POST",
          headers: mine(),
          body: JSON.stringify({ slug, name: "Self filter" }),
        })
      ).status,
    ).toBe(201);
    const created = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: mine(),
      body: JSON.stringify({ title: "Who wakes whom" }),
    });
    expect(created.status).toBe(201);
    number = (await json(created)).number as number;

    const bob = await addUserWithToken(t.ctx, `bob-${slug}`);
    expect(
      (
        await t.app.request(`/api/projects/${slug}/members/${bob.user.id}`, {
          method: "PUT",
          headers: mine(),
          body: JSON.stringify({ role: "writer" }),
        })
      ).status,
    ).toBe(204);

    // "Now", so the opened event stays out of every assertion below.
    baseline = (
      await json(
        await t.app.request(
          `/api/projects/${slug}/issues/${number}/timeline?last=1&limit=1`,
          { headers: { cookie } },
        ),
      )
    ).next_cursor as string;

    const comment = async (headers: Record<string, string>, body: string) => {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${number}/comments`,
        { method: "POST", headers, body: JSON.stringify({ body }) },
      );
      expect(res.status).toBe(201);
    };
    // One machine account, four provenances — the shape that made T-121
    // a bug rather than a preference.
    await comment(mine(SENTINEL), "sentinel");
    await comment(mine(WORKER), "worker");
    await comment(mine(), "web");
    await comment(mine(""), "blank");
    await comment(
      { "content-type": "application/json", ...bob.headers },
      "bob",
    );

    // Events travel the second table; same filter, separate SQL.
    const statuses = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
    const closed = statuses.find(
      (s: { category: string }) => s.category === "closed",
    );
    expect(
      (
        await t.app.request(`/api/projects/${slug}/issues/${number}`, {
          method: "PATCH",
          headers: mine(SENTINEL),
          body: JSON.stringify({ status_id: closed.id }),
        })
      ).status,
    ).toBe(200);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("keeps exclude_actor alone meaning the whole account", async () => {
    expect(await timeline(`after=${baseline}&exclude_actor=${meId}`)).toEqual([
      "bob",
    ]);
  });

  it("drops one agent session and nothing else", async () => {
    expect(
      await timeline(`after=${baseline}&exclude_agent_session=${SENTINEL}`),
    ).toEqual(["worker", "web", "blank", "bob"]);
  });

  it("composes the two axes into 'not mine'", async () => {
    // The sibling worker survives on the same account, my own writes do
    // not, and a session-less write of mine falls back to the account —
    // including one whose harness reported an empty session id.
    // The closing event carries the sentinel session too, so it goes.
    const expected = ["worker", "bob"];
    const qs = `after=${baseline}&exclude_actor=${meId}&exclude_agent_session=${SENTINEL}`;
    expect(await timeline(qs)).toEqual(expected);
    expect(await activity(qs)).toEqual(expected);
    expect(await cross(qs)).toEqual(expected);
  });

  it("filters events by the session that produced them", async () => {
    const qs = `after=${baseline}&exclude_actor=${meId}&exclude_agent_session=${WORKER}`;
    expect(await timeline(qs)).toEqual(["sentinel", "bob", "event:closed"]);
  });

  it("rejects an empty exclude_agent_session", async () => {
    const res = await t.app.request(
      `/api/projects/${slug}/activity?exclude_agent_session=`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(422);
  });
});
