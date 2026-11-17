import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("status usage T-712", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  async function statusId(slug: string, name: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/statuses`, {
      headers: { cookie },
    });
    const row = (await json(res)).find(
      (s: { name: string }) => s.name === name,
    );
    return row.id;
  }

  async function createIssue(slug: string, status: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        title: `in ${status}`,
        status_id: await statusId(slug, status),
      }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  async function usage(slug: string) {
    const res = await t.app.request(`/api/projects/${slug}/statuses/usage`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of ["usage-a", "usage-b"]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => t.cleanup());

  it("counts live and trashed issues per status, zeros for unused ones", async () => {
    await createIssue("usage-a", "Next");
    await createIssue("usage-a", "Next");
    const trashed = await createIssue("usage-a", "Done");
    await createIssue("usage-a", "Done");
    const del = await t.app.request(`/api/projects/usage-a/issues/${trashed}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(del.status).toBeLessThan(300);
    // Another project's issues never land in this one's counts.
    await createIssue("usage-b", "Next");

    const rows = await usage("usage-a");
    expect(rows).toHaveLength(8);
    expect(rows.map((r: { id: number }) => r.id)).toEqual(
      [...rows.map((r: { id: number }) => r.id)].sort((a, b) => a - b),
    );
    const byId = new Map(rows.map((r: { id: number }) => [r.id, r]));
    expect(byId.get(await statusId("usage-a", "Next"))).toMatchObject({
      issues: 2,
      trashed: 0,
    });
    expect(byId.get(await statusId("usage-a", "Done"))).toMatchObject({
      issues: 1,
      trashed: 1,
    });
    expect(byId.get(await statusId("usage-a", "Backlog"))).toMatchObject({
      issues: 0,
      trashed: 0,
    });
  });
});
