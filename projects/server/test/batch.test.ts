import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../src/bootstrap.ts";
import { batchRoutes, rejectBatchTarget } from "../src/routes/batch.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

/**
 * The route mounted against a hand-written dispatcher instead of the real
 * app: the tests below assert on how the gateway handles what the
 * dispatcher returns, so the dispatcher has to be the thing under control.
 */
function batchFakeApp(
  respond: (url: string) => Response | Promise<Response> = () =>
    Response.json({ ok: 1 }),
) {
  const fake = {
    fetch: (req: Request, _env?: unknown) =>
      respond(new URL(req.url).pathname.replace(/^\/api/, "")),
  };
  // Only what forwardedHeaderNames reads: auth mode decides the header set.
  const appCtx = { config: { auth: { mode: "single" } } } as AppContext;
  const app = new OpenAPIHono<{ Variables: { appCtx: AppContext } }>();
  app.use("*", async (c, next) => {
    c.set("appCtx", appCtx);
    await next();
  });
  app.route(
    "/api",
    batchRoutes(() => fake),
  );
  return app;
}

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("rejectBatchTarget (allowlist)", () => {
  it("accepts plain api-relative GET targets", () => {
    expect(rejectBatchTarget("/projects/p/statuses")).toBeNull();
    expect(rejectBatchTarget("/me")).toBeNull();
    expect(rejectBatchTarget("/projects/p/issues?status=1&limit=5")).toBeNull();
  });

  it("rejects absolute urls, recursion, and event streams", () => {
    expect(rejectBatchTarget("https://example.com/x")?.status).toBe(400);
    expect(rejectBatchTarget("/batch")?.status).toBe(400);
    expect(rejectBatchTarget("/batch/nested")?.status).toBe(400);
    expect(rejectBatchTarget("/projects/p/events")?.status).toBe(400);
  });

  it("keeps a project named 'events' reachable", () => {
    expect(rejectBatchTarget("/projects/events")).toBeNull();
    expect(rejectBatchTarget("/projects/p/events?x=1")?.status).toBe(400);
  });
});

describe("POST /api/batch", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "batchproj", name: "Batch Project" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  function post(body: unknown, headers: Record<string, string> = {}) {
    return t.app.request("/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("dispatches a mixed batch positionally with per-item isolation", async () => {
    const res = await post(
      {
        requests: [
          { url: "/projects/batchproj/statuses" },
          { url: "/projects/batchproj/issues?limit=5" },
          { url: "/projects/nope/statuses" },
          { url: "/projects/batchproj/events" },
        ],
      },
      { cookie },
    );
    expect(res.status).toBe(200);
    const { responses } = await json(res);
    expect(responses).toHaveLength(4);
    expect(responses[0].status).toBe(200);
    expect(responses[0].body.map((s: { name: string }) => s.name)).toContain(
      "Todo",
    );
    expect(responses[1].status).toBe(200);
    expect(responses[1].body.items).toEqual([]);
    expect(responses[2].status).toBe(404);
    expect(responses[3].status).toBe(400);
    expect(responses[3].body.error.code).toBe("batch_target_not_allowed");
  });

  it("authorizes per item, not on the envelope", async () => {
    // No session at all: the envelope still answers, public halves work.
    const res = await post({
      requests: [{ url: "/auth/mode" }, { url: "/me" }],
    });
    expect(res.status).toBe(200);
    const { responses } = await json(res);
    expect(responses[0].status).toBe(200);
    expect(responses[0].body.mode).toBeDefined();
    expect(responses[1].status).toBe(401);
  });

  it("forwards bearer tokens like cookies", async () => {
    const { headers } = await addUserWithToken(t.ctx, "batch-pat");
    const res = await post({ requests: [{ url: "/me" }] }, headers);
    const { responses } = await json(res);
    expect(responses[0].status).toBe(200);
    expect(responses[0].body.login).toBe("batch-pat");
  });

  it("rejects envelope-shape failures as a whole", async () => {
    expect((await post({ requests: [] }, { cookie })).status).toBe(422);
    const oversized = {
      requests: Array.from({ length: 51 }, () => ({ url: "/me" })),
    };
    expect((await post(oversized, { cookie })).status).toBe(422);
  });
});

describe("batch dispatch isolation (T-368)", () => {
  it("turns a throwing sub-response read into that item's 502", async () => {
    // Pre-fix this rejected the Promise.all and answered 500 for the whole
    // batch, contradicting the route's own per-item isolation promise.
    const app = batchFakeApp((url) =>
      url === "/bad"
        ? new Response("<not json>", {
            headers: { "content-type": "application/json" },
          })
        : Response.json({ ok: 1 }),
    );
    const res = await app.request("/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ url: "/good" }, { url: "/bad" }] }),
    });
    expect(res.status).toBe(200);
    const { responses } = await json(res);
    expect(responses).toHaveLength(2);
    expect(responses[0].status).toBe(200);
    expect(responses[1].status).toBe(502);
    expect(responses[1].body.error.code).toBe("batch_target_failed");
  });
});

describe("POST /api/batch streaming (T-368)", () => {
  type Frame =
    | { event: "item"; index: number; status: number; body: unknown }
    | { event: "done"; count: number };

  /**
   * SSE frame reader over a live stream response. One reader for the whole
   * test: a ReadableStream is locked to its first getReader() call.
   */
  function sseReader(res: Response) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const text = new TextDecoder();
    let buffer = "";
    const frames: Frame[] = [];
    /** Resolves once `want` holds on the frames read so far. */
    const readUntil = async (
      want: (frames: Frame[]) => boolean,
    ): Promise<Frame[]> => {
      for (;;) {
        if (want(frames)) return frames;
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before the expected frames");
        buffer += text.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end === -1) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event === "item" && data !== undefined) {
            // The tag travels beside the payload: callers match on it.
            frames.push({ event, ...JSON.parse(data) });
          } else if (event === "done" && data !== undefined) {
            frames.push({ event, ...JSON.parse(data) });
          }
        }
      }
    };
    return { readUntil };
  }
  type FakeApp = ReturnType<typeof batchFakeApp>;
  function post(app: FakeApp, accept?: string) {
    return app.request("/api/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accept === undefined ? {} : { accept }),
      },
      body: JSON.stringify({
        requests: [{ url: "/fast" }, { url: "/slow" }],
      }),
    });
  }

  it("delivers each item as it completes, correlated by index", async () => {
    // The slow item hangs on a promise the test itself controls, so the
    // fast item's frame must already be readable — a Promise.all hold-back
    // would block this read until the test times out.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = batchFakeApp((url) =>
      url === "/slow"
        ? gate.then(() => Response.json({ slow: true }))
        : Response.json({ fast: true }),
    );

    const res = await post(app, "text/event-stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const { readUntil } = sseReader(res);
    const early = await readUntil((f) => f.some((x) => x.event === "item"));
    const firstItem = early.find((x) => x.event === "item");
    if (firstItem?.event !== "item") throw new Error("no item frame");
    expect(firstItem.index).toBe(0);
    expect(firstItem.status).toBe(200);

    release?.();
    const rest = await readUntil((f) => f.some((x) => x.event === "done"));
    const doneFrame = rest.find((x) => x.event === "done");
    if (doneFrame?.event !== "done") throw new Error("no done frame");
    expect(doneFrame.count).toBe(2);
    const slowItem = rest.find((x) => x.event === "item" && x.index === 1);
    if (slowItem?.event !== "item") throw new Error("no slow item frame");
    expect(slowItem.body).toEqual({ slow: true });
  });

  it("keeps the JSON envelope for requests without the accept header", async () => {
    const app = batchFakeApp();
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const { responses } = await json(res);
    expect(responses).toHaveLength(2);
    expect(responses[0].body).toEqual({ ok: 1 });
    expect(responses[1].body).toEqual({ ok: 1 });
  });
});

describe("batch OpenAPI document (T-368)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("declares both content types on the 200", async () => {
    const res = await t.app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = await json(res);
    const content =
      doc.paths["/api/batch"]?.post?.responses?.["200"]?.content ?? {};
    expect(Object.keys(content).sort()).toEqual([
      "application/json",
      "text/event-stream",
    ]);
  });
});
