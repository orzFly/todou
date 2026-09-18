import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const json = (response: Response): Promise<unknown> => response.json();

describe.skipIf(!PG_URL)("insights on PostgreSQL", () => {
  let t: TestApp;
  let cookie: string;
  const slug = `insights-pg-${Date.now().toString(36)}`;

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const response = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(response.status).toBe(201);
  });

  afterAll(async () => t.cleanup());

  it("serializes two first saves against the same settings version", async () => {
    const settings = (await json(
      await t.app.request(`/api/projects/${slug}/insights/settings`, {
        headers: { cookie },
      }),
    )) as {
      version: string;
      roles: Array<{ status_id: number; role: string }>;
    };
    const roles = settings.roles.map((role, index) => ({
      status_id: role.status_id,
      role: index === 0 ? "excluded" : role.role,
    }));
    const request = () =>
      t.app.request(`/api/projects/${slug}/insights/settings`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ version: settings.version, roles }),
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });

  it.each([
    ["America/New_York", "2026-03-08", "2026-03-10", [23, 24]],
    ["Asia/Kolkata", "2026-01-01", "2026-01-03", [24, 24]],
    ["Pacific/Apia", "2011-12-29", "2012-01-01", [24, 24]],
  ] as const)(
    "uses database calendar boundaries for %s",
    async (tz, from, to, expectedHours) => {
      const response = await t.app.request(
        `/api/projects/${slug}/insights/burn?${new URLSearchParams({ from, to, grain: "1d", tz })}`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      const body = (await json(response)) as {
        buckets: Array<{ start: string; end: string }>;
      };
      const hours = body.buckets.map(
        (bucket) =>
          (Date.parse(bucket.end) - Date.parse(bucket.start)) /
          (60 * 60 * 1000),
      );
      expect(hours).toEqual(expectedHours);
    },
  );
});
