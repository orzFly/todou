import { IssueWatchMark, ProjectWatchers } from "@todou/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type WatcherClock, WatcherRegistry } from "../src/events/watchers.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";
import { agent, openFeed } from "./watchers-helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("issue watch marks (T-669)", () => {
  let t: TestApp;
  let cookie: string;
  let outsider: Awaited<ReturnType<typeof addUserWithToken>>;
  let card: number;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of ["alpha", "hidden"]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
    const res = await t.app.request("/api/projects/alpha/issues", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "marked card" }),
    });
    expect(res.status).toBe(201);
    card = (await json(res)).number;
    outsider = await addUserWithToken(t.ctx, "newcomer");
  });

  afterEach(() => {
    t.ctx.watchers.dispose();
    t.ctx.watchers = new WatcherRegistry(t.ctx.bus);
  });

  afterAll(async () => {
    t.ctx.watchers.dispose();
    await t.cleanup();
  });

  const put = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { cookie, ...agent("s1") },
  ) =>
    t.app.request(path, {
      method: "PUT",
      headers:
        body === undefined
          ? headers
          : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const del = (
    path: string,
    headers: Record<string, string> = { cookie, ...agent("s1") },
  ) => t.app.request(path, { method: "DELETE", headers });
  const watchers = async (): Promise<ProjectWatchers> => {
    const res = await t.app.request("/api/projects/alpha/watchers", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return ProjectWatchers.parse(await json(res));
  };
  const path = () => `/api/projects/alpha/issues/${card}/watch`;

  it("sets a mark with the default TTL, listed only under its card", async () => {
    const before = Date.now();
    const res = await put(path(), undefined);
    expect(res.status).toBe(200);
    const mark = IssueWatchMark.parse(await json(res));
    expect(mark.issue_number).toBe(card);
    const ttl = Date.parse(mark.expires_at) - before;
    expect(ttl).toBeGreaterThanOrEqual(900_000);
    expect(ttl).toBeLessThan(905_000);

    const listed = await watchers();
    expect(listed.project).toEqual([]);
    expect(listed.issues[String(card)]).toEqual([
      expect.objectContaining({
        agent_context: { agent: "claude-code", session_id: "s1" },
        kind: "marked",
        scope: "issue",
        since: mark.since,
        expires_at: mark.expires_at,
      }),
    ]);
    const overview = await json(
      await t.app.request("/api/watchers", { headers: { cookie } }),
    );
    expect(overview.projects).toEqual({});
  });

  it("refuses a TTL out of range, a missing header, a missing card and an unreadable project", async () => {
    for (const ttl_seconds of [3601, 0, 1.5]) {
      const res = await put(path(), { ttl_seconds });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe("validation_failed");
    }
    for (const res of [
      await put(path(), { ttl_seconds: 60 }, { cookie }),
      await del(path(), { cookie }),
    ]) {
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("agent_context_required");
    }
    expect((await put("/api/projects/alpha/issues/999/watch", {})).status).toBe(
      404,
    );
    const hidden = `/api/projects/hidden/issues/1/watch`;
    const as = { ...outsider.headers, ...agent("s1") };
    expect((await put(hidden, {}, as)).status).toBe(404);
    expect((await del(hidden, as)).status).toBe(404);
    expect(t.ctx.watchers.size()).toBe(0);
  });

  it("renews in place: since stays, expires_at moves", async () => {
    const first = await json(await put(path(), { ttl_seconds: 60 }));
    const second = await json(await put(path(), { ttl_seconds: 3600 }));
    expect(second.since).toBe(first.since);
    expect(Date.parse(second.expires_at)).toBeGreaterThan(
      Date.parse(first.expires_at),
    );
    expect((await watchers()).issues[String(card)]).toHaveLength(1);
  });

  it("removes a mark, and removing none is still 204", async () => {
    await put(path(), {});
    expect((await del(path())).status).toBe(204);
    expect((await watchers()).issues).toEqual({});
    expect((await del(path())).status).toBe(204);
    // The card is not checked on the way out.
    expect((await del("/api/projects/alpha/issues/999/watch")).status).toBe(
      204,
    );
  });

  it("publishes a card-level watchers change on set and on remove", async () => {
    const feed = await openFeed(t, "/api/events?presence=1", { cookie });
    const nextWatchers = async () => {
      for (;;) {
        const event = await feed.nextChange();
        if (event.entity === "watchers") return event;
      }
    };
    try {
      await put(path(), {});
      expect(await nextWatchers()).toMatchObject({
        project: "alpha",
        issue_number: card,
      });
      await del(path());
      expect(await nextWatchers()).toMatchObject({
        project: "alpha",
        issue_number: card,
      });
    } finally {
      feed.abort();
    }
  });

  it("drops the listing once the TTL passes", async () => {
    let now = Date.now();
    const timers = new Set<{ at: number; fn: () => void }>();
    const clock: WatcherClock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { at: now + ms, fn };
        timers.add(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as { at: number; fn: () => void });
      },
    };
    t.ctx.watchers = new WatcherRegistry(t.ctx.bus, { clock });
    expect((await put(path(), { ttl_seconds: 60 })).status).toBe(200);
    now += 59_000;
    expect((await watchers()).issues[String(card)]).toHaveLength(1);
    now += 1_000;
    for (const timer of [...timers]) {
      if (timer.at <= now) {
        timers.delete(timer);
        timer.fn();
      }
    }
    expect((await watchers()).issues).toEqual({});
  });
});
