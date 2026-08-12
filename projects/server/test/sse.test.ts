import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/events/bus.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("EventBus", () => {
  it("fans out per project and unsubscribes cleanly", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.subscribe(1, (e) => seen.push(e.id));
    bus.subscribe(2, (e) => seen.push(e.id * 100));

    bus.publish(1, { entity: "issue", id: 7, action: "updated" });
    bus.publish(2, { entity: "issue", id: 8, action: "updated" });
    expect(seen).toEqual([7, 800]);

    off();
    bus.publish(1, { entity: "issue", id: 9, action: "updated" });
    expect(seen).toEqual([7, 800]);
    expect(bus.subscriberCount(1)).toBe(0);
  });

  it("isolates broken subscribers", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe(1, () => {
      throw new Error("boom");
    });
    bus.subscribe(1, (e) => seen.push(e.id));
    bus.publish(1, { entity: "issue", id: 1, action: "created" });
    expect(seen).toEqual([1]);
  });
});

describe("SSE + OpenAPI", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "live";
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Live" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "watched issue" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("serves a public OpenAPI document", async () => {
    const res = await t.app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = await json(res);
    expect(doc.info.title).toBe("todou");
    expect(Object.keys(doc.paths)).toContain("/api/projects/{slug}/issues");
  });

  it("hides the change feed from non-members", async () => {
    const outsider = await addUserWithToken(t.ctx, "sse-outsider");
    const res = await t.app.request(`/api/projects/${slug}/events`, {
      headers: outsider.headers,
    });
    expect(res.status).toBe(404);
  });

  it("streams pointer events to a subscribed member", async () => {
    const controller = new AbortController();
    const res = await t.app.request(`/api/projects/${slug}/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Wait for the hello frame so the subscription is definitely live.
    while (!buffer.includes("event: hello")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended early");
      buffer += decoder.decode(value, { stream: true });
    }

    // Trigger a change through the normal API path.
    const posted = await t.app.request(
      `/api/projects/${slug}/issues/1/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "live comment" }),
      },
    );
    expect(posted.status).toBe(201);

    while (!buffer.includes("event: change")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before change event");
      buffer += decoder.decode(value, { stream: true });
    }
    const dataLine = buffer
      .split("\n")
      .find(
        (l, i, all) => l.startsWith("data:") && all[i - 1] === "event: change",
      );
    expect(dataLine).toBeDefined();
    const event = JSON.parse((dataLine as string).slice(5).trim());
    expect(event.entity).toBe("timeline");
    expect(event.action).toBe("created");
    expect(event.issue_number).toBe(1);

    controller.abort();
  });
});

describe("SSE shutdown", () => {
  it("ends live streams and unsubscribes when the app shuts down", async () => {
    const t = await makeTestApp();
    const cookie = await t.login();
    await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "dying", name: "Dying" }),
    });

    const res = await t.app.request("/api/projects/dying/events", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!buffer.includes("event: hello")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended early");
      buffer += decoder.decode(value, { stream: true });
    }
    expect(t.ctx.bus.subscriberCount(1)).toBe(1);

    t.ctx.shutdown.abort();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(t.ctx.bus.subscriberCount(1)).toBe(0);

    await t.cleanup();
  });
});
