import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejectBatchTarget } from "../src/routes/batch.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

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
