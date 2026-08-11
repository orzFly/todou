import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Spike validation for the experimental worker-thread PGlite host
 * (database.projects.workers = true): the full API flow must behave
 * identically to the inline host, including drizzle transactions.
 */
describe("worker-hosted pglite (experimental)", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("dedicated", { workers: true });
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("runs the full issue flow through a worker-hosted database", async () => {
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: "workerized", name: "Workerized" }),
    });
    expect(created.status).toBe(201);

    // Transactional path: issue numbering + opened event.
    const issue = await json(
      await t.app.request("/api/projects/workerized/issues", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: "born in a worker" }),
      }),
    );
    expect(issue.number).toBe(1);

    const comment = await t.app.request(
      "/api/projects/workerized/issues/1/comments",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ body: "hello from the other thread" }),
      },
    );
    expect(comment.status).toBe(201);

    const timeline = await json(
      await t.app.request("/api/projects/workerized/issues/1/timeline", {
        headers: { cookie },
      }),
    );
    expect(timeline.items.map((i: { type: string }) => i.type)).toEqual([
      "event",
      "comment",
    ]);

    // Concurrent transactional writes stay consistent.
    const burst = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const res = await t.app.request("/api/projects/workerized/issues", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ title: `burst ${i}` }),
        });
        return json(res);
      }),
    );
    const numbers = burst.map((b: { number: number }) => b.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("parallelizes across two project databases (smoke benchmark)", async () => {
    for (const slug of ["bench-a", "bench-b"]) {
      await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
    }
    const start = performance.now();
    await Promise.all(
      ["bench-a", "bench-b"].flatMap((slug) =>
        Array.from({ length: 20 }, (_, i) =>
          t.app.request(`/api/projects/${slug}/issues`, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ title: `bench ${i}` }),
          }),
        ),
      ),
    );
    const elapsed = performance.now() - start;
    // Informational only — no flaky assertions on timing.
    console.info(
      `worker host: 40 issue creations across 2 project dbs in ${elapsed.toFixed(0)}ms`,
    );
    expect(elapsed).toBeGreaterThan(0);
  });
});
