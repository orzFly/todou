import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessions, tokens, users } from "../src/db/system-schema.ts";
import { issueToken } from "../src/services/tokens.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

/**
 * An open stream is re-checked against its credential (T-624). "Closed" is
 * asserted as "the next frame after a write is the end of the stream": a
 * leak shows up as the change frame instead, which fails at once rather than
 * by timing out.
 */
describe("SSE streams follow their credential (T-624)", () => {
  let t: TestApp;
  let cookie: string;
  let adminId: number;
  const slug = "sec";

  /** A raw feed; `next` returns null once the server has closed it. */
  const open = async (path: string, headers: Record<string, string>) => {
    const res = await t.app.request(path, { headers });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: Array<{ event: string; data: string }> = [];
    const next = async (
      skip: string[] = ["ping"],
    ): Promise<{ event: string; data: string } | null> => {
      for (;;) {
        const frame = frames.shift();
        if (frame !== undefined) {
          if (skip.includes(frame.event)) continue;
          return frame;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut !== -1) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          frames.push({ event, data: data.join("\n") });
          cut = buffer.indexOf("\n\n");
        }
      }
    };
    expect((await next())?.event).toBe("hello");
    return {
      next,
      close: () => void reader.cancel().catch(() => {}),
    };
  };

  /** Resolves to "open" if the feed has not ended within `ms`. */
  const endsWithin = async (
    feed: Awaited<ReturnType<typeof open>>,
    ms: number,
  ): Promise<"ended" | "open"> => {
    const ended = (async () => {
      while ((await feed.next()) !== null) {
        // Drain whatever was in flight; only the end matters here.
      }
      return "ended" as const;
    })();
    return Promise.race([ended, delay(ms).then(() => "open" as const)]);
  };

  const comment = async (body: string, auth = cookie) => {
    const res = await t.app.request(`/api/projects/${slug}/issues/1/comments`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
  };

  const addMember = async (userId: number) => {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "reader" }),
    });
    expect(res.status).toBe(204);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", undefined, { sse: { heartbeatMs: 50 } });
    cookie = await t.login();
    const me = await t.app.request("/api/me", { headers: { cookie } });
    adminId = ((await me.json()) as { id: number }).id;
    await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug, name: "Sec" }),
    });
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "watched" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("closes a stream whose token is revoked, and only that token's", async () => {
    const u = await addUserWithToken(t.ctx, "alice");
    await addMember(u.user.id);
    const second = await issueToken(t.ctx.router.system(), u.user.id, {
      name: "second",
    });
    const [first] = await t.ctx.router
      .system()
      .select()
      .from(tokens)
      .where(eq(tokens.name, "alice-token"));
    const revoked = await open("/api/events?metadata=*&inbox=1", u.headers);
    const kept = await open("/api/events", {
      authorization: `Bearer ${second.token}`,
    });

    const res = await t.app.request(`/api/me/tokens/${first?.id}`, {
      method: "DELETE",
      headers: u.headers,
    });
    expect(res.status).toBe(204);
    await comment("SECRET-AFTER-REVOKE");

    expect(await revoked.next()).toBeNull();
    expect((await kept.next())?.event).toBe("change");
    kept.close();
  });

  it("closes an agent's stream when the agent is disabled", async () => {
    const bot = await addUserWithToken(t.ctx, "bot-one", {
      kind: "machine",
      ownerId: adminId,
    });
    await addMember(bot.user.id);
    const feed = await open("/api/events?metadata=*", bot.headers);

    const res = await t.app.request(`/api/agents/${bot.user.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(204);
    await comment("SECRET-AFTER-DISABLE");

    expect(await feed.next()).toBeNull();
  });

  it("closes a session's stream on logout, leaving the next session's open", async () => {
    const old = await t.login();
    const feed = await open(`/api/projects/${slug}/events`, { cookie: old });
    const res = await t.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: old },
    });
    expect(res.status).toBe(204);
    const fresh = await t.login();
    const kept = await open("/api/events", { cookie: fresh });
    await comment("SECRET-AFTER-LOGOUT", fresh);

    expect(await feed.next()).toBeNull();
    expect((await kept.next())?.event).toBe("change");
    kept.close();
  });

  // The paths below publish no signal, so only the heartbeat re-check can
  // see them: the admin CLI writes from another process, and expiry is not
  // an event at all.
  it("closes on the next heartbeat after a revocation it was not told about", async () => {
    const u = await addUserWithToken(t.ctx, "bob");
    await addMember(u.user.id);
    const feed = await open("/api/events", u.headers);
    await t.ctx.router
      .system()
      .update(tokens)
      .set({ revokedAt: new Date() })
      .where(eq(tokens.userId, u.user.id));
    expect(await endsWithin(feed, 2000)).toBe("ended");
  });

  it("closes on the next heartbeat after the user is disabled", async () => {
    const u = await addUserWithToken(t.ctx, "carol");
    const feed = await open("/api/events", u.headers);
    await t.ctx.router
      .system()
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, u.user.id));
    expect(await endsWithin(feed, 2000)).toBe("ended");
  });

  it("closes on the next heartbeat after its session expires", async () => {
    const session = await t.login();
    const feed = await open("/api/events", { cookie: session });
    // Every other session of the built-in user stays as it was; expire the
    // newest one, which is this feed's.
    const rows = await t.ctx.router.system().select().from(sessions);
    const newest = rows.reduce((a, b) => (a.id > b.id ? a : b));
    await t.ctx.router
      .system()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, newest.id));
    expect(await endsWithin(feed, 2000)).toBe("ended");
  });

  it("closes a pinned stream that only instance-admin rights held open", async () => {
    const root = await addUserWithToken(t.ctx, "root", { instanceAdmin: true });
    const feed = await open(`/api/projects/${slug}/events`, root.headers);
    await t.ctx.router
      .system()
      .update(users)
      .set({ isInstanceAdmin: false })
      .where(eq(users.id, root.user.id));
    expect(await endsWithin(feed, 2000)).toBe("ended");
  });

  it("keeps a valid stream open across heartbeats", async () => {
    const u = await addUserWithToken(t.ctx, "dave");
    await addMember(u.user.id);
    const feed = await open("/api/events", u.headers);
    for (let i = 0; i < 3; i++) {
      expect((await feed.next([]))?.event).toBe("ping");
    }
    await comment("still here");
    expect((await feed.next())?.event).toBe("change");
    feed.close();
  });
});
