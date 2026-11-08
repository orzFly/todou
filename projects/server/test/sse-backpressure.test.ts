import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import type { ChangeEvent } from "@todou/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectMembers, projects } from "../src/db/system-schema.ts";
import { STREAM_QUEUE_MAX } from "../src/routes/sse.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type TestApp,
} from "./helpers.ts";

/**
 * A connection that stops reading is cut off rather than buffered for
 * without bound (T-625). Under `app.request` a write stalls as soon as the
 * test stops reading — the response stream has no buffer of its own — so
 * "stops reading" is simply not calling `next`.
 */
describe("SSE backpressure (T-625)", () => {
  let t: TestApp;
  let cookie: string;
  let user: Awaited<ReturnType<typeof addUserWithToken>>;
  let mine: number;
  let theirs: number;
  const WRITE_DEADLINE_MS = 200;

  const open = async (path = "/api/events") => {
    const res = await t.app.request(path, { headers: user.headers });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: Array<{ event: string; data: string }> = [];
    /** The next non-ping frame, or null once the server has closed. */
    const next = async (): Promise<{ event: string; data: string } | null> => {
      for (;;) {
        const frame = frames.shift();
        if (frame !== undefined) {
          if (frame.event === "ping") continue;
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
    return { next, close: () => void reader.cancel().catch(() => {}) };
  };

  const endsWithin = async (
    feed: Awaited<ReturnType<typeof open>>,
    ms: number,
  ): Promise<"ended" | "open"> => {
    const ended = (async () => {
      while ((await feed.next()) !== null) {
        // Drain what was already written; only the end matters.
      }
      return "ended" as const;
    })();
    return Promise.race([ended, delay(ms).then(() => "open" as const)]);
  };

  const burst = (projectId: number, n: number, from = 1) => {
    for (let i = from; i < from + n; i++) {
      t.ctx.bus.publish(projectId, {
        entity: "issue",
        id: i,
        action: "updated",
      });
    }
  };

  const createProject = async (slug: string) => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
    const [row] = await t.ctx.router
      .system()
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    return row?.id as number;
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", undefined, {
      sse: { heartbeatMs: 50, writeDeadlineMs: WRITE_DEADLINE_MS },
    });
    cookie = await t.login();
    mine = await createProject("mine");
    theirs = await createProject("theirs");
    user = await addUserWithToken(t.ctx, "alice");
    const res = await t.app.request(
      `/api/projects/mine/members/${user.user.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(res.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("cuts off a connection whose backlog passes the cap", async () => {
    const base = t.ctx.bus.subscriberCount();
    const feed = await open();
    burst(mine, STREAM_QUEUE_MAX + 1);
    expect(await endsWithin(feed, 2000)).toBe("ended");
    expect(t.ctx.bus.subscriberCount()).toBe(base);
  });

  it("delivers a burst just under the cap whole", async () => {
    const feed = await open();
    burst(mine, STREAM_QUEUE_MAX);
    for (let i = 1; i <= STREAM_QUEUE_MAX; i++) {
      const frame = await feed.next();
      expect(JSON.parse(frame?.data ?? "null")).toMatchObject({ id: i });
    }
    burst(mine, 1, 0);
    expect(JSON.parse((await feed.next())?.data ?? "null").id).toBe(0);
    feed.close();
  });

  it("does not count projects the caller cannot see against the cap", async () => {
    const feed = await open();
    burst(theirs, STREAM_QUEUE_MAX * 4);
    burst(mine, 1, 7);
    expect(JSON.parse((await feed.next())?.data ?? "null")).toMatchObject({
      id: 7,
      project: "mine",
    });
    feed.close();
  });

  it("keeps a just-granted project's events published in the same tick", async () => {
    const bob = await addUserWithToken(t.ctx, "bob");
    const feed = await open();
    const bobFeed = await (async () => {
      const saved = user;
      user = bob;
      try {
        return await open();
      } finally {
        user = saved;
      }
    })();
    feed.close();
    await t.ctx.router
      .system()
      .insert(projectMembers)
      .values({ projectId: theirs, userId: bob.user.id, role: "reader" });
    // One tick: the issue event arrives before the stream has had any chance
    // to recompute what bob can see, so it must not be filtered against the
    // set as it stood.
    t.ctx.bus.publish(theirs, {
      entity: "member",
      id: bob.user.id,
      action: "updated",
    });
    t.ctx.bus.publish(theirs, { entity: "issue", id: 99, action: "updated" });
    expect(JSON.parse((await bobFeed.next())?.data ?? "null")).toMatchObject({
      entity: "member",
    });
    expect(JSON.parse((await bobFeed.next())?.data ?? "null")).toMatchObject({
      entity: "issue",
      id: 99,
      project: "theirs",
    });
    bobFeed.close();
  });

  it("does not recompute visibility for an update to a project it cannot see", async () => {
    const feed = await open();
    const log = await countStatements(t, async () => {
      t.ctx.bus.publish(theirs, {
        entity: "project",
        id: theirs,
        action: "updated",
      });
      burst(mine, 1, 11);
      expect(JSON.parse((await feed.next())?.data ?? "null").id).toBe(11);
    });
    expect(
      log.statements.filter((s) => s.sql.includes("project_members")),
    ).toEqual([]);
    feed.close();
  });

  it("cuts off a peer that stopped reading once a write outlasts the deadline", async () => {
    const feed = await open();
    burst(mine, 5, 1);
    await delay(WRITE_DEADLINE_MS * 3);
    expect(await endsWithin(feed, 2000)).toBe("ended");
  });

  it("cuts off a silent peer through its heartbeat alone", async () => {
    const feed = await open();
    await delay(WRITE_DEADLINE_MS * 3);
    expect(await endsWithin(feed, 2000)).toBe("ended");
  });

  it("keeps a slow reader that keeps up within the deadline", async () => {
    const feed = await open();
    burst(mine, 8, 1);
    for (let i = 1; i <= 8; i++) {
      await delay(WRITE_DEADLINE_MS / 4);
      expect(JSON.parse((await feed.next())?.data ?? "null").id).toBe(i);
    }
    feed.close();
  });

  it("closes the socket of a real peer that stopped reading", async () => {
    const server = serve({
      fetch: t.app.fetch,
      port: 0,
      hostname: "127.0.0.1",
    });
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const base = t.ctx.bus.subscriberCount();
    // Watched from the server's side: a paused client learns of the close
    // only once it reads again, and releasing the server's socket is the
    // claim here.
    const accepted = once(server, "connection") as Promise<[Socket]>;
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    const [serverSide] = await accepted;
    const closed = once(serverSide, "close");
    socket.write(
      `GET /api/events?metadata=* HTTP/1.1\r\nHost: todou.test\r\n` +
        `Authorization: ${user.headers.authorization}\r\n\r\n`,
    );
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    while (!received.includes("event: hello")) await once(socket, "data");
    socket.pause();

    // Big enough frames to fill the loopback buffers on both sides, few
    // enough to stay under the backlog cap: only the write deadline can
    // end this connection, and only destroying the socket releases it — the
    // adapter would otherwise wait on `drain` for good.
    const value = "x".repeat(32 * 1024);
    for (let i = 0; i < STREAM_QUEUE_MAX - 1; i++) {
      t.ctx.bus.publish(mine, {
        entity: "metadata",
        id: 1,
        action: "updated",
        issue_number: 1,
        metadata: {
          namespace: "load",
          key: `k${i}`,
          value,
          updated_at: new Date().toISOString(),
          updated_by: { id: 1, login: "user", display_name: "user" },
        },
      } as ChangeEvent);
    }
    const outcome = await Promise.race([
      closed.then(() => "closed"),
      delay(5000).then(() => "open"),
    ]);
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    expect(outcome).toBe("closed");
    expect(t.ctx.bus.subscriberCount()).toBe(base);
  });
});
