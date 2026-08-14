import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventBus } from "../src/events/bus.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("EventBus", () => {
  it("fans out with the project id and unsubscribes cleanly", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    const off = bus.subscribe((pid, e) => {
      if (pid === 1) seen.push(e.id);
    });
    bus.subscribe((pid, e) => {
      if (pid === 2) seen.push(e.id * 100);
    });

    bus.publish(1, { entity: "issue", id: 7, action: "updated" });
    bus.publish(2, { entity: "issue", id: 8, action: "updated" });
    expect(seen).toEqual([7, 800]);

    off();
    bus.publish(1, { entity: "issue", id: 9, action: "updated" });
    expect(seen).toEqual([7, 800]);
    expect(bus.subscriberCount()).toBe(1);
  });

  it("isolates broken subscribers", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((_pid, e) => seen.push(e.id));
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
    expect(t.ctx.bus.subscriberCount()).toBe(1);

    t.ctx.shutdown.abort();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(t.ctx.bus.subscriberCount()).toBe(0);

    await t.cleanup();
  });
});

describe("user-level SSE stream (T-122)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  /**
   * Incremental SSE frame reader. "Never delivered" is asserted by order:
   * trigger the filtered event, then a marker event, and require the marker
   * to be the next change frame — a leak would surface as the wrong frame.
   */
  class SseReader {
    #reader: ReadableStreamDefaultReader<Uint8Array>;
    #decoder = new TextDecoder();
    #buffer = "";
    #frames: Array<{ event: string; data: string }> = [];
    #controller: AbortController;

    private constructor(
      reader: ReadableStreamDefaultReader<Uint8Array>,
      controller: AbortController,
    ) {
      this.#reader = reader;
      this.#controller = controller;
    }

    static async open(path: string, auth: Record<string, string>) {
      const controller = new AbortController();
      const res = await t.app.request(path, {
        headers: auth,
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const stream = new SseReader(reader, controller);
      await stream.next("hello");
      return stream;
    }

    // biome-ignore lint/suspicious/noExplicitAny: test-side frame poking
    async next(name: string): Promise<any> {
      for (;;) {
        const frame = this.#frames.shift();
        if (frame) {
          if (frame.event !== name) continue;
          return frame.data === "" ? null : JSON.parse(frame.data);
        }
        const { value, done } = await this.#reader.read();
        if (done) throw new Error(`stream ended waiting for ${name}`);
        this.#buffer += this.#decoder.decode(value, { stream: true });
        let cut = this.#buffer.indexOf("\n\n");
        while (cut !== -1) {
          const raw = this.#buffer.slice(0, cut);
          this.#buffer = this.#buffer.slice(cut + 2);
          let event = "message";
          const data: string[] = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trim());
          }
          this.#frames.push({ event, data: data.join("\n") });
          cut = this.#buffer.indexOf("\n\n");
        }
      }
    }

    /** Await the server closing the stream. */
    async end(): Promise<void> {
      for (;;) {
        const { done } = await this.#reader.read();
        if (done) return;
      }
    }

    abort() {
      this.#controller.abort();
    }
  }

  const comment = async (slug: string, issue: number, body: string) => {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue}/comments`,
      { method: "POST", headers: headers(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(201);
  };
  const setMember = async (slug: string, userId: number, role = "reader") => {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role }),
    });
    expect(res.status).toBe(204);
  };
  const removeMember = async (slug: string, userId: number) => {
    const res = await t.app.request(`/api/projects/${slug}/members/${userId}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(204);
  };
  const createProject = async (slug: string) => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
  };

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of ["alpha", "beta"]) {
      await createProject(slug);
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: `${slug} issue` }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("requires authentication", async () => {
    const res = await t.app.request("/api/events");
    expect(res.status).toBe(401);
  });

  it("carries every readable project, each event stamped with its slug", async () => {
    const stream = await SseReader.open("/api/events", { cookie });
    await comment("alpha", 1, "hi alpha");
    let event = await stream.next("change");
    expect(event.project).toBe("alpha");

    await comment("beta", 1, "hi beta");
    // Drain alpha's paired events until beta's first frame arrives.
    for (;;) {
      event = await stream.next("change");
      if (event.project === "beta") break;
      expect(event.project).toBe("alpha");
    }
    stream.abort();
  });

  it("filters projects the caller cannot read", async () => {
    const b = await addUserWithToken(t.ctx, "sse-b");
    await setMember("beta", b.user.id);
    const stream = await SseReader.open("/api/events", b.headers);

    await comment("alpha", 1, "invisible to b");
    await comment("beta", 1, "visible marker");
    const event = await stream.next("change");
    expect(event.project).toBe("beta");
    stream.abort();
  });

  it("starts a just-granted project mid-stream", async () => {
    const c = await addUserWithToken(t.ctx, "sse-c");
    // Zero visible projects is a legal stream: hello already arrived.
    const stream = await SseReader.open("/api/events", c.headers);

    await setMember("alpha", c.user.id);
    const granted = await stream.next("change");
    expect(granted).toMatchObject({
      entity: "member",
      id: c.user.id,
      action: "updated",
      project: "alpha",
    });

    await comment("alpha", 1, "now visible to c");
    const event = await stream.next("change");
    expect(event.project).toBe("alpha");
    stream.abort();
  });

  it("announces a revocation, then the project falls silent", async () => {
    const d = await addUserWithToken(t.ctx, "sse-d");
    await setMember("alpha", d.user.id);
    const stream = await SseReader.open("/api/events", d.headers);

    await removeMember("alpha", d.user.id);
    const revoked = await stream.next("change");
    expect(revoked).toMatchObject({
      entity: "member",
      id: d.user.id,
      action: "deleted",
      project: "alpha",
    });

    await comment("alpha", 1, "filtered after revocation");
    await setMember("alpha", d.user.id); // marker: the re-grant frame
    const marker = await stream.next("change");
    expect(marker).toMatchObject({
      entity: "member",
      action: "updated",
      project: "alpha",
    });
    stream.abort();
  });

  it("adds a created project to the creator's stream", async () => {
    const stream = await SseReader.open("/api/events", { cookie });
    await createProject("gamma");
    const created = await stream.next("change");
    expect(created).toMatchObject({
      entity: "project",
      action: "created",
      project: "gamma",
    });

    const res = await t.app.request("/api/projects/gamma/issues", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "gamma issue" }),
    });
    expect(res.status).toBe(201);
    const event = await stream.next("change");
    expect(event.project).toBe("gamma");
    stream.abort();
  });

  it("adds a created project to an instance admin's stream", async () => {
    const admin = await addUserWithToken(t.ctx, "sse-admin", {
      instanceAdmin: true,
    });
    const stream = await SseReader.open("/api/events", admin.headers);
    await createProject("delta");
    const created = await stream.next("change");
    expect(created).toMatchObject({
      entity: "project",
      action: "created",
      project: "delta",
    });
    stream.abort();
  });

  it("announces a deleted project", async () => {
    const stream = await SseReader.open("/api/events", { cookie });
    const res = await t.app.request("/api/projects/delta", {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(204);
    const deleted = await stream.next("change");
    expect(deleted).toMatchObject({
      entity: "project",
      action: "deleted",
      project: "delta",
    });
    stream.abort();
  });

  it("closes the per-project stream when access is revoked", async () => {
    const e = await addUserWithToken(t.ctx, "sse-e");
    await setMember("alpha", e.user.id);
    const stream = await SseReader.open(
      "/api/projects/alpha/events",
      e.headers,
    );

    await removeMember("alpha", e.user.id);
    const revoked = await stream.next("change");
    expect(revoked).toMatchObject({
      entity: "member",
      action: "deleted",
      project: "alpha",
    });
    await stream.end();
  });

  it("closes the per-project stream when the project is deleted", async () => {
    await createProject("closing");
    const stream = await SseReader.open("/api/projects/closing/events", {
      cookie,
    });
    const res = await t.app.request("/api/projects/closing", {
      method: "DELETE",
      headers: headers(),
    });
    expect(res.status).toBe(204);
    const deleted = await stream.next("change");
    expect(deleted).toMatchObject({
      entity: "project",
      action: "deleted",
      project: "closing",
    });
    await stream.end();
  });
});
