import { ProjectWatchers, WatchersOverview } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WatcherRegistry } from "../src/events/watchers.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";
import { agent, openFeed, until } from "./watchers-helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("watchers read endpoints (T-540)", () => {
  let t: TestApp;
  let cookie: string;
  let reader: Awaited<ReturnType<typeof addUserWithToken>>;
  let owned: Awaited<ReturnType<typeof addUserWithToken>>;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of ["alpha", "beta", "gamma"]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
    reader = await addUserWithToken(t.ctx, "alice");
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    owned = await addUserWithToken(t.ctx, "claude-agent", {
      kind: "machine",
      ownerId: me.id,
    });
    // `alice` reads alpha and beta; the agent account reads alpha only.
    for (const [slug, userId] of [
      ["alpha", reader.user.id],
      ["beta", reader.user.id],
      ["alpha", owned.user.id],
    ] as const) {
      const res = await t.app.request(
        `/api/projects/${slug}/members/${userId}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(res.status).toBe(204);
    }
    t.ctx.watchers = new WatcherRegistry(t.ctx.bus, { lingerMs: 0 });
  });

  afterAll(async () => {
    t.ctx.watchers.dispose();
    await t.cleanup();
  });

  const get = async (path: string, auth: Record<string, string>) => {
    const res = await t.app.request(path, { headers: auth });
    return { status: res.status, body: await json(res) };
  };

  it("splits project-level from card-level, in the published shape", async () => {
    const project = await openFeed(t, "/api/events?watch=project:alpha", {
      ...owned.headers,
      ...agent("s-project"),
    });
    const card = await openFeed(
      t,
      "/api/events?watch=issue:alpha/4&watch_kind=question_wait",
      { ...owned.headers, ...agent("s-card") },
    );
    const { status, body } = await get(
      "/api/projects/alpha/watchers",
      reader.headers,
    );
    expect(status).toBe(200);
    expect(ProjectWatchers.parse(body)).toEqual(body);
    expect(body.project).toHaveLength(1);
    expect(body.project[0]).toMatchObject({
      scope: "project",
      kind: "watch",
      agent_context: { session_id: "s-project" },
      user: {
        login: "claude-agent",
        kind: "machine",
        owner: { login: "user" },
      },
    });
    expect(Object.keys(body.issues)).toEqual(["4"]);
    expect(body.issues["4"][0]).toMatchObject({
      scope: "issue",
      kind: "question_wait",
      agent_context: { session_id: "s-card" },
    });

    // Only project-level watchers reach the overview.
    const overview = await get("/api/watchers", reader.headers);
    expect(WatchersOverview.parse(overview.body)).toEqual(overview.body);
    expect(Object.keys(overview.body.projects)).toEqual(["alpha"]);
    expect(overview.body.projects.alpha).toHaveLength(1);

    project.abort();
    card.abort();
    await until(async () => t.ctx.watchers.size() === 0);
  });

  it("lists an all-projects watcher under every project its account reads, and only those", async () => {
    const all = await openFeed(t, "/api/events?watch=all", {
      ...owned.headers,
      ...agent("s-all"),
    });
    // alice reads alpha and beta; the agent only alpha.
    const overview = await get("/api/watchers", reader.headers);
    expect(Object.keys(overview.body.projects)).toEqual(["alpha"]);
    expect(overview.body.projects.alpha[0].scope).toBe("all_projects");
    expect(
      (await get("/api/projects/beta/watchers", reader.headers)).body.project,
    ).toEqual([]);
    expect(
      (await get("/api/projects/gamma/watchers", { cookie })).body.project,
    ).toEqual([]);
    all.abort();
    await until(async () => t.ctx.watchers.size() === 0);
  });

  it("answers an unreadable project with the usual 404", async () => {
    expect(
      (await get("/api/projects/gamma/watchers", reader.headers)).status,
    ).toBe(404);
  });

  it("answers an empty overview when nobody watches", async () => {
    expect((await get("/api/watchers", reader.headers)).body).toEqual({
      projects: {},
    });
  });
});
