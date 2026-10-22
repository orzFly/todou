import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WatcherRegistry } from "../src/events/watchers.ts";
import { parseWatchParam } from "../src/routes/sse.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";
import { agent, openFeed, until } from "./watchers-helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("parseWatchParam (T-540)", () => {
  it("accepts every form", () => {
    expect(parseWatchParam("all")).toEqual({ all: true });
    expect(parseWatchParam("project:todou,project:7,issue:todou/540")).toEqual({
      all: false,
      projects: ["todou", "7"],
      issues: [["todou", 540]],
    });
  });

  it.each([
    ["all mixed with others", "all,project:todou"],
    ["an empty entry", "project:todou,"],
    ["an empty value", ""],
    ["a non-numeric number", "issue:todou/abc"],
    ["a zero number", "issue:todou/0"],
    ["a missing number", "issue:todou"],
    ["an unknown kind", "label:todou"],
    ["a malformed slug", "project:Not A Slug"],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseWatchParam(raw)).toThrow(
      expect.objectContaining({ status: 400, code: "invalid_watch" }),
    );
  });

  it("rejects more than 50 entries", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `issue:todou/${i + 1}`);
    expect(() => parseWatchParam(fifty.join(","))).not.toThrow();
    expect(() =>
      parseWatchParam([...fifty, "project:todou"].join(",")),
    ).toThrow(expect.objectContaining({ code: "invalid_watch" }));
  });
});

describe("/api/events watch declaration (T-540)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of ["seen", "hidden", "marker"]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
    const res = await t.app.request("/api/projects/seen/issues", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "watched" }),
    });
    expect(res.status).toBe(201);
    // No linger: a dropped connection should vanish as soon as it is released.
    t.ctx.watchers = new WatcherRegistry(t.ctx.bus, { lingerMs: 0 });
  });

  afterAll(async () => {
    t.ctx.watchers.dispose();
    await t.cleanup();
  });

  const watchers = async (slug: string) => {
    const res = await t.app.request(`/api/projects/${slug}/watchers`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  };

  it("lists a declaring connection with agent context, and drops it on disconnect", async () => {
    const feed = await openFeed(t, "/api/events?watch=issue:seen/1", {
      cookie,
      ...agent("s-listed"),
    });
    const body = await watchers("seen");
    expect(body.project).toEqual([]);
    expect(body.issues["1"]).toHaveLength(1);
    expect(body.issues["1"][0]).toMatchObject({
      agent_context: { agent: "claude-code", session_id: "s-listed" },
      kind: "watch",
      scope: "issue",
      user: { login: "user" },
    });
    feed.abort();
    await until(async () => (await watchers("seen")).issues["1"] === undefined);
  });

  it("records the declared kind", async () => {
    const feed = await openFeed(
      t,
      "/api/events?watch=issue:seen/1&watch_kind=spec_wait",
      { cookie, ...agent("s-kind") },
    );
    expect((await watchers("seen")).issues["1"][0].kind).toBe("spec_wait");
    feed.abort();
    await until(async () => t.ctx.watchers.size() === 0);
  });

  it("does not list a connection without agent context or without watch", async () => {
    const bare = await openFeed(t, "/api/events?watch=project:seen", {
      cookie,
    });
    const undeclared = await openFeed(t, "/api/events", {
      cookie,
      ...agent("s-undeclared"),
    });
    expect(t.ctx.watchers.size()).toBe(0);
    expect((await watchers("seen")).project).toEqual([]);
    bare.abort();
    undeclared.abort();
  });

  it("refuses a malformed declaration with 400 invalid_watch", async () => {
    for (const query of [
      "watch=all,project:seen",
      "watch=all&watch_kind=nope",
    ]) {
      const res = await t.app.request(`/api/events?${query}`, {
        headers: { cookie, ...agent("s-bad") },
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_watch");
    }
  });

  it("drops a project the caller cannot read and never leaks its watchers event", async () => {
    const bot = await addUserWithToken(t.ctx, "newcomer");
    const res = await t.app.request(
      `/api/projects/seen/members/${bot.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(res.status).toBe(204);

    const botFeed = await openFeed(t, "/api/events?presence=1", bot.headers);

    const declaring = await openFeed(
      t,
      "/api/events?watch=project:hidden,project:seen",
      { ...bot.headers, ...agent("s-bot") },
    );
    expect((await watchers("hidden")).project).toEqual([]);
    expect((await watchers("seen")).project).toHaveLength(1);
    // The admin declares on a project the bot cannot read: its event must
    // not reach the bot, so the next frame the bot sees is about `seen`.
    const admin = await openFeed(t, "/api/events?watch=project:hidden", {
      cookie,
      ...agent("s-admin"),
    });
    expect((await watchers("hidden")).project).toHaveLength(1);
    const first = await botFeed.nextChange();
    expect(first).toMatchObject({ entity: "watchers", project: "seen" });
    declaring.abort();
    const second = await botFeed.nextChange();
    expect(second).toMatchObject({ entity: "watchers", project: "seen" });
    admin.abort();
    botFeed.abort();
    await until(async () => t.ctx.watchers.size() === 0);
  });

  it("sends watchers events only to presence=1 connections", async () => {
    const plain = await openFeed(t, "/api/events", { cookie });
    const presence = await openFeed(t, "/api/events?presence=1", { cookie });
    const declaring = await openFeed(t, "/api/events?watch=issue:seen/1", {
      cookie,
      ...agent("s-presence"),
    });
    expect(await presence.nextChange()).toEqual({
      entity: "watchers",
      action: "updated",
      id: expect.any(Number),
      issue_number: 1,
      project: "seen",
    });
    // A marker the plain feed does receive: if the watchers event had
    // leaked, it would arrive first.
    const marker = await t.app.request("/api/projects/marker", {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ name: "Marker" }),
    });
    expect(marker.status).toBe(200);
    expect(await plain.nextChange()).toMatchObject({
      entity: "project",
      project: "marker",
    });
    declaring.abort();
    plain.abort();
    presence.abort();
    await until(async () => t.ctx.watchers.size() === 0);
  });

  it("lists an all-projects watcher under every project its account reads", async () => {
    const feed = await openFeed(t, "/api/events?watch=all", {
      cookie,
      ...agent("s-all"),
    });
    for (const slug of ["seen", "hidden", "marker"]) {
      const body = await watchers(slug);
      expect(body.project.map((w: { scope: string }) => w.scope)).toEqual([
        "all_projects",
      ]);
    }
    feed.abort();
    await until(async () => t.ctx.watchers.size() === 0);
  });
});
