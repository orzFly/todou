import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

const json = (response: Response): Promise<unknown> => response.json();

describe.each(PLACEMENTS)("insights burn API (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  const slug = `insights-burn-${placement}`;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    const project = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(project.status).toBe(201);
    const statuses = (await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    )) as Array<{ id: number; name: string }>;
    const todo = statuses.find((status) => status.name === "Todo");
    const shipped = statuses.find((status) => status.name === "Shipped");
    if (!todo || !shipped) throw new Error("seeded statuses missing");
    for (const [title, statusId] of [
      ["remaining", todo.id],
      ["shipped", shipped.id],
    ] as const) {
      const issue = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title, status_id: statusId }),
      });
      expect(issue.status).toBe(201);
    }
  });

  afterAll(async () => t.cleanup());

  it("returns current-cohort A and D values in one consistent response", async () => {
    const to = new Date(Date.now() + 3600_000);
    const from = new Date(to.getTime() - 24 * 3600_000);
    const search = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      grain: "1h",
      tz: "UTC",
    });
    const response = await t.app.request(
      `/api/projects/${slug}/insights/burn?${search}`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    const body = (await json(response)) as {
      cohort: { mode: string; count: number };
      settings_version: string;
      statuses: Array<{ name: string; role: string; category: string }>;
      buckets: Array<{
        stock: {
          remaining: { value: number };
          open_total: { value: number };
        } | null;
        flow: { created_completed: { value: number } } | null;
      }>;
    };
    expect(body.cohort).toEqual({ mode: "current", count: 2 });
    expect(body.settings_version).not.toBe("");
    expect(
      body.statuses.find((status) => status.name === "Shipped"),
    ).toMatchObject({
      role: "completed",
      category: "open",
    });
    expect(body.buckets.at(-1)?.stock?.remaining.value).toBe(1);
    expect(body.buckets.at(-1)?.stock?.open_total.value).toBe(2);
    expect(
      body.buckets.reduce(
        (sum, bucket) => sum + (bucket.flow?.created_completed.value ?? 0),
        0,
      ),
    ).toBe(1);
  });

  it("rejects invalid timezone, future from, and excessive explicit buckets", async () => {
    const now = Date.now();
    for (const query of [
      {
        from: new Date(now - 3600_000).toISOString(),
        to: new Date(now + 3600_000).toISOString(),
        grain: "1h",
        tz: "Not/A_Zone",
      },
      {
        from: new Date(now + 3600_000).toISOString(),
        to: new Date(now + 7200_000).toISOString(),
        grain: "1h",
        tz: "UTC",
      },
      {
        from: new Date(now - 401 * 3600_000).toISOString(),
        to: new Date(now).toISOString(),
        grain: "1h",
        tz: "UTC",
      },
      {
        from: new Date(now - 3600_000).toISOString(),
        to: new Date(now).toISOString(),
        grain: "2h",
        tz: "UTC",
      },
    ]) {
      const response = await t.app.request(
        `/api/projects/${slug}/insights/burn?${new URLSearchParams(query)}`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(400);
    }
  });
});
