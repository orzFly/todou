import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

/**
 * "One query for the whole page" is the condition the whole read path rests
 * on — it is why every issue response can carry both directions. So the
 * assertion is the call COUNT, not a duration: a page that fetched per card
 * would still be fast enough on twenty rows, and a machine under load would
 * drown any timing threshold anyway.
 */
let calls = 0;
vi.mock("../src/services/blocks.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/blocks.ts")>();
  return {
    ...actual,
    blocksForIssues: (
      ...args: Parameters<typeof actual.blocksForIssues>
    ): ReturnType<typeof actual.blocksForIssues> => {
      calls += 1;
      return actual.blocksForIssues(...args);
    },
  };
});

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const SLUG = "block-cost";

describe("block reads cost one query per page T-377", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    expect(
      (
        await t.app.request("/api/projects", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ slug: SLUG, name: "Cost" }),
        })
      ).status,
    ).toBe(201);
    for (let i = 0; i < 25; i++) {
      const res = await t.app.request(`/api/projects/${SLUG}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: `card ${i}` }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("asks once for a twenty-row page", async () => {
    calls = 0;
    const res = await t.app.request(`/api/projects/${SLUG}/issues?limit=20`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).items).toHaveLength(20);
    expect(calls).toBe(1);
  });

  it("asks once for a single card too", async () => {
    calls = 0;
    const res = await t.app.request(`/api/projects/${SLUG}/issues/1`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});
