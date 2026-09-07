import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFrontiers } from "../src/db/project-schema.ts";
import { EventBus } from "../src/events/bus.ts";
import { INBOX_JUDGE_QUEUE_MAX } from "../src/routes/sse.ts";
import { accessibleProjectRows, routeInfoOf } from "../src/services/access.ts";
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

  it("routes me events by user id (T-275)", () => {
    const bus = new EventBus();
    const mine: string[] = [];
    const theirs: string[] = [];
    const off = bus.subscribeMe(1, (e) => mine.push(e.kind));
    bus.subscribeMe(2, (e) => theirs.push(e.kind));

    bus.publishMe(1, { kind: "prefs" });
    expect(mine).toEqual(["prefs"]);
    expect(theirs).toEqual([]);

    // A user nobody is listening for is not an error; the event is dropped.
    bus.publishMe(3, { kind: "prefs" });

    off();
    bus.publishMe(1, { kind: "prefs" });
    expect(mine).toEqual(["prefs"]);
  });

  it("reports whether a user has a me subscriber (T-275)", () => {
    const bus = new EventBus();
    expect(bus.hasMeSubscriber(1)).toBe(false);
    const off = bus.subscribeMe(1, () => {});
    expect(bus.hasMeSubscriber(1)).toBe(true);
    expect(bus.hasMeSubscriber(2)).toBe(false);
    off();
    expect(bus.hasMeSubscriber(1)).toBe(false);
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

    /**
     * The next frame of any name but `ping`. `next` skips names it was not
     * asked for, so an assertion that some event never arrives has to read
     * frames without naming one — otherwise a leaked frame is skipped in
     * silence and the test passes for the wrong reason.
     */
    async nextFrame(): Promise<{ event: string; data: string }> {
      for (;;) {
        const frame = this.#frames.shift();
        if (frame) {
          if (frame.event === "ping") continue;
          return frame;
        }
        const { value, done } = await this.#reader.read();
        if (done) throw new Error("stream ended waiting for a frame");
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

  // Whether a change concerns the receiver is a question only the server can
  // answer (T-273): the payload is a pointer, so a client seeing it has no
  // way to tell. Opt-in, because a subscriber that treats events as a bare
  // nudge would be paying for an answer it never reads.
  describe("per-receiver inbox row (T-275)", () => {
    let zoe: Awaited<ReturnType<typeof addUserWithToken>>;
    let alphaId: number;

    /** The five deciding fields of one row of /api/me/inbox. */
    const inboxRowOf = async (
      who: Record<string, string>,
      slug: string,
      number: number,
    ) => {
      const res = await t.app.request("/api/me/inbox", { headers: who });
      expect(res.status).toBe(200);
      const row = (await json(res)).items.find(
        (i: { number: number; project: { slug: string } }) =>
          i.project.slug === slug && i.number === number,
      );
      if (row === undefined) return null;
      return {
        updated_at: row.updated_at,
        unread: row.unread,
        unread_comments: row.unread_comments,
        pending_spec_review: row.pending_spec_review,
        open_questions: row.open_questions,
      };
    };

    /** Reading the inbox mints the caller's read frontier for a project;
     *  without one, activity is dated before the reader's epoch and the
     *  judgement rightly calls it read. The web client loads it at boot. */
    const readInbox = async (who: Record<string, string>) => {
      const res = await t.app.request("/api/me/inbox", { headers: who });
      expect(res.status).toBe(200);
    };

    const commentAs = async (
      slug: string,
      issue: number,
      body: string,
      who: Record<string, string>,
    ) => {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...who },
          body: JSON.stringify({ body }),
        },
      );
      expect(res.status).toBe(201);
    };

    /** The next change frame of a given entity, skipping the others one
     *  write fans out into. */
    // biome-ignore lint/suspicious/noExplicitAny: test-side frame poking
    const nextOf = async (stream: SseReader, entity: string): Promise<any> => {
      for (;;) {
        const event = await stream.next("change");
        if (event.entity === entity) return event;
      }
    };

    beforeAll(async () => {
      zoe = await addUserWithToken(t.ctx, "sse-zoe");
      await setMember("alpha", zoe.user.id, "writer");
      const res = await t.app.request("/api/projects/alpha", {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      alphaId = (await json(res)).id;
    });

    it("omits the field entirely without ?inbox=1", async () => {
      // The CLI and every pre-T-273 client subscribe this way, and this is
      // what keeps them from paying for a judgement they never read.
      await readInbox(zoe.headers);
      const stream = await SseReader.open("/api/events", zoe.headers);
      await commentAs("alpha", 1, "no field please", { cookie });
      // Both frames one comment fans out into: its timeline entry and the
      // issue's own touch.
      for (let i = 0; i < 2; i++) {
        expect(await stream.next("change")).not.toHaveProperty("inbox_row");
      }
      stream.abort();
    });

    it("describes the row of a card that just entered the reader's inbox", async () => {
      await readInbox(zoe.headers);
      const stream = await SseReader.open("/api/events?inbox=1", zoe.headers);
      const res = await t.app.request("/api/projects/alpha/issues", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: "opened for zoe" }),
      });
      expect(res.status).toBe(201);
      const number = (await json(res)).number;
      const event = await nextOf(stream, "issue");
      expect(event).toMatchObject({ action: "created" });
      // Field for field what /me/inbox would hand the same reader: the
      // client compares the two, so any disagreement is a refetch that
      // never stops or a badge that never moves.
      expect(event.inbox_row).toEqual(
        await inboxRowOf(zoe.headers, "alpha", number),
      );
      expect(event.inbox_row).toMatchObject({ unread: true });
      stream.abort();
    });

    it("tells two receivers apart on one event", async () => {
      // The writer's own comment cannot light their badge (the candidate
      // scans exclude the actor), while the same event puts the card in the
      // other reader's inbox. One event, two answers.
      await readInbox(zoe.headers);
      await readInbox({ cookie });
      const created = await t.app.request("/api/projects/alpha/issues", {
        method: "POST",
        headers: { "content-type": "application/json", ...zoe.headers },
        body: JSON.stringify({ title: "zoe's card" }),
      });
      expect(created.status).toBe(201);
      const number = (await json(created)).number;
      // Read away the card itself, so the comment below is the only thing
      // that can put it back in this reader's inbox.
      const read = await t.app.request(
        `/api/projects/alpha/issues/${number}/read`,
        { method: "PUT", headers: headers(), body: "{}" },
      );
      expect(read.status).toBe(204);
      await new Promise((r) => setTimeout(r, 5));

      const hers = await SseReader.open("/api/events?inbox=1", zoe.headers);
      const mine = await SseReader.open("/api/events?inbox=1", { cookie });

      await commentAs("alpha", number, "zoe speaking", zoe.headers);
      const hersEvent = await nextOf(hers, "timeline");
      const mineEvent = await nextOf(mine, "timeline");
      // Null rather than an absent key: "not in your inbox" is an answer,
      // and the client acts on it (it may still hold a stale row).
      expect("inbox_row" in hersEvent).toBe(true);
      expect(hersEvent.inbox_row).toBeNull();
      expect(mineEvent.inbox_row).toEqual(
        await inboxRowOf({ cookie }, "alpha", number),
      );
      expect(mineEvent.inbox_row).not.toBeNull();

      hers.abort();
      mine.abort();
    });

    it("omits the field on events that name no issue", async () => {
      const stream = await SseReader.open("/api/events?inbox=1", { cookie });
      const res = await t.app.request("/api/projects/alpha/labels", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: "no-issue-here" }),
      });
      expect(res.status).toBe(201);
      const event = await nextOf(stream, "label");
      expect("inbox_row" in event).toBe(false);
      stream.abort();
    });

    it("still delivers the event when the judgement throws", async () => {
      const stream = await SseReader.open("/api/events?inbox=1", { cookie });
      const forProject = t.ctx.router.forProject.bind(t.ctx.router);
      // Published straight onto the bus so the failure lands in the drain
      // loop and nowhere else — an API write would take the same broken
      // route on its way in.
      t.ctx.router.forProject = () => {
        throw new Error("judgement stub: no database for you");
      };
      try {
        t.ctx.bus.publish(alphaId, {
          entity: "comment",
          id: 1,
          action: "created",
          issue_number: 1,
        });
        const event = await nextOf(stream, "comment");
        // `in`, not `=== undefined`: the latter would also accept a null,
        // which means something else entirely.
        expect("inbox_row" in event).toBe(false);
      } finally {
        t.ctx.router.forProject = forProject;
      }

      // The stream survived it: the next event is judged as usual.
      t.ctx.bus.publish(alphaId, {
        entity: "comment",
        id: 1,
        action: "created",
        issue_number: 1,
      });
      expect("inbox_row" in (await nextOf(stream, "comment"))).toBe(true);
      stream.abort();
    });

    it("stops judging while the connection's backlog is deep", async () => {
      const stream = await SseReader.open("/api/events?inbox=1", { cookie });
      const burst = INBOX_JUDGE_QUEUE_MAX + 8;
      for (let i = 0; i < burst; i++) {
        t.ctx.bus.publish(alphaId, {
          entity: "comment",
          id: i + 1,
          action: "created",
          issue_number: 1,
        });
      }
      const seen = [];
      for (let i = 0; i < burst; i++)
        seen.push(await nextOf(stream, "comment"));

      // The front of the burst is skipped and the tail is judged: the
      // degradation follows the backlog, and lifts on its own once the
      // connection catches up.
      expect("inbox_row" in seen[0]).toBe(false);
      expect("inbox_row" in seen[burst - 1]).toBe(true);
      stream.abort();
    });
  });

  // Read positions and preferences write no change event, so these are the
  // two dimensions the T-273 signal could not cover at all (T-275).
  describe("me events (T-275)", () => {
    let ivy: Awaited<ReturnType<typeof addUserWithToken>>;

    const readInbox = async (who: Record<string, string>) => {
      const res = await t.app.request("/api/me/inbox", { headers: who });
      expect(res.status).toBe(200);
    };

    const markRead = async (
      slug: string,
      number: number,
      who: Record<string, string>,
      origin?: string,
    ) => {
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${number}/read`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...who,
            ...(origin === undefined ? {} : { "x-todou-origin": origin }),
          },
          body: "{}",
        },
      );
      expect(res.status).toBe(204);
    };

    /** Ivy's own /me/inbox row for a card of alpha, or null for none. */
    const inboxRowOfIvy = async (number: number) => {
      const res = await t.app.request("/api/me/inbox", {
        headers: ivy.headers,
      });
      expect(res.status).toBe(200);
      return (
        (await json(res)).items.find(
          (i: { number: number; project: { slug: string } }) =>
            i.project.slug === "alpha" && i.number === number,
        ) ?? null
      );
    };

    /** A card of alpha that is in ivy's inbox because she has not read it. */
    const cardForIvy = async (title: string): Promise<number> => {
      await readInbox(ivy.headers);
      await new Promise((r) => setTimeout(r, 5));
      const res = await t.app.request("/api/projects/alpha/issues", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return (await json(res)).number;
    };

    beforeAll(async () => {
      ivy = await addUserWithToken(t.ctx, "sse-ivy");
      await setMember("alpha", ivy.user.id, "writer");
    });

    it("goes to the reader who wrote it and to nobody else", async () => {
      const number = await cardForIvy("ivy's to read");
      const hers = await SseReader.open("/api/events?inbox=1", ivy.headers);
      const mine = await SseReader.open("/api/events?inbox=1", { cookie });

      await markRead("alpha", number, ivy.headers);
      const frame = await hers.nextFrame();
      expect(frame.event).toBe("me");
      expect(JSON.parse(frame.data)).toMatchObject({
        kind: "issue_read",
        project: "alpha",
        issue_number: number,
      });

      // The other stream must see nothing of it. Read frames without
      // naming an event, so a leaked `me` frame cannot be skipped in
      // silence, and use an ordinary change event as the marker.
      await comment("alpha", 1, "marker for the other stream");
      const other = await mine.nextFrame();
      expect(other.event).toBe("change");

      hers.abort();
      mine.abort();
    });

    it("says nothing to a stream that did not ask for inbox signals", async () => {
      const number = await cardForIvy("ivy's second");
      const stream = await SseReader.open("/api/events", ivy.headers);
      await markRead("alpha", number, ivy.headers);
      await comment("alpha", 1, "marker for the plain stream");
      expect((await stream.nextFrame()).event).toBe("change");
      stream.abort();
    });

    it("carries the row the reader is left with, or null for none", async () => {
      const number = await cardForIvy("ivy's third");
      const stream = await SseReader.open("/api/events?inbox=1", ivy.headers);

      // Unread was this card's only reason to be there, so reading it
      // leaves no row — and the event says so with a null rather than by
      // leaving the field out.
      await markRead("alpha", number, ivy.headers);
      const event = JSON.parse((await stream.nextFrame()).data);
      expect(event.inbox_row).toBeNull();
      expect(await inboxRowOfIvy(number)).toBeNull();
      stream.abort();
    });

    it("carries a row when reading leaves the card in the inbox", async () => {
      const number = await cardForIvy("ivy's fourth, with a question");
      const asked = await t.app.request(
        `/api/projects/alpha/issues/${number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            body: "which one?",
            component: {
              type: "questions",
              questions: [
                {
                  question: "Pick one",
                  options: [{ label: "left" }, { label: "right" }],
                },
              ],
            },
          }),
        },
      );
      expect(asked.status).toBe(201);
      const stream = await SseReader.open("/api/events?inbox=1", ivy.headers);

      await markRead("alpha", number, ivy.headers);
      const event = JSON.parse((await stream.nextFrame()).data);
      const row = await inboxRowOfIvy(number);
      expect(event.inbox_row).toEqual({
        updated_at: row.updated_at,
        unread: row.unread,
        unread_comments: row.unread_comments,
        pending_spec_review: row.pending_spec_review,
        open_questions: row.open_questions,
      });
      expect(event.inbox_row).toMatchObject({
        unread: false,
        unread_comments: 0,
        open_questions: 1,
      });
      stream.abort();
    });

    it("echoes x-todou-origin back, truncated, and omits it when absent", async () => {
      const number = await cardForIvy("ivy's fifth");
      const stream = await SseReader.open("/api/events?inbox=1", ivy.headers);

      await markRead("alpha", number, ivy.headers, "tab-one");
      expect(JSON.parse((await stream.nextFrame()).data).origin).toBe(
        "tab-one",
      );

      await markRead("alpha", number, ivy.headers);
      expect("origin" in JSON.parse((await stream.nextFrame()).data)).toBe(
        false,
      );

      const long = "x".repeat(200);
      await markRead("alpha", number, ivy.headers, long);
      const echoed = JSON.parse((await stream.nextFrame()).data).origin;
      expect(echoed).toBe("x".repeat(64));
      stream.abort();
    });

    it("reports a bulk sweep, with its scope when it had one", async () => {
      await readInbox(ivy.headers);
      const stream = await SseReader.open("/api/events?inbox=1", ivy.headers);

      const scoped = await t.app.request("/api/me/read", {
        method: "PUT",
        headers: { "content-type": "application/json", ...ivy.headers },
        body: JSON.stringify({ projects: ["alpha"] }),
      });
      expect(scoped.status).toBe(204);
      expect(JSON.parse((await stream.nextFrame()).data)).toMatchObject({
        kind: "reads_swept",
        projects: ["alpha"],
      });

      const all = await t.app.request("/api/me/read", {
        method: "PUT",
        headers: { "content-type": "application/json", ...ivy.headers },
        body: "{}",
      });
      expect(all.status).toBe(204);
      const event = JSON.parse((await stream.nextFrame()).data);
      expect(event).toMatchObject({ kind: "reads_swept" });
      expect("projects" in event).toBe(false);
      stream.abort();
    });

    it("reports a preference change", async () => {
      const stream = await SseReader.open("/api/events?inbox=1", ivy.headers);
      const res = await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...ivy.headers },
        body: JSON.stringify({ show_weak_unread: false }),
      });
      expect(res.status).toBe(200);
      const frame = await stream.nextFrame();
      expect(frame.event).toBe("me");
      expect(JSON.parse(frame.data)).toMatchObject({ kind: "prefs" });
      stream.abort();

      const back = await t.app.request("/api/me/prefs", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...ivy.headers },
        body: JSON.stringify({ show_weak_unread: true }),
      });
      expect(back.status).toBe(200);
    });

    /**
     * With nobody listening the fingerprint must not be computed at all,
     * pinned to a side effect rather than to a stub: the judgement runs
     * through `unreadIssueState`, which inserts the reader's read frontier
     * for a project on first use. A user who has never had unread state
     * computed in a project therefore has no frontier row there — until
     * something computes one. This is also the semantics ?inbox=1 protects:
     * the hot path must not mint frontiers on people's behalf.
     */
    it("skips the fingerprint when no connection is listening", async () => {
      const hal = await addUserWithToken(t.ctx, "sse-hal");
      await createProject("frontierless");
      await setMember("frontierless", hal.user.id, "writer");
      const created = await t.app.request("/api/projects/frontierless/issues", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: "never judged" }),
      });
      expect(created.status).toBe(201);
      const number = (await json(created)).number;

      const rows = await accessibleProjectRows(t.ctx, hal.user);
      const project = rows.find((r) => r.slug === "frontierless");
      if (!project) throw new Error("hal cannot read frontierless");
      const db = await t.ctx.router.forProject(routeInfoOf(project));
      const frontiers = async () =>
        db
          .select({ userId: readFrontiers.userId })
          .from(readFrontiers)
          .where(
            and(
              eq(readFrontiers.projectId, project.id),
              eq(readFrontiers.userId, hal.user.id),
            ),
          );

      expect(await frontiers()).toEqual([]);
      await markRead("frontierless", number, hal.headers);
      expect(await frontiers()).toEqual([]);

      const stream = await SseReader.open("/api/events?inbox=1", hal.headers);
      await markRead("frontierless", number, hal.headers);
      await stream.nextFrame();
      expect(await frontiers()).toHaveLength(1);
      stream.abort();
    });
  });
});
