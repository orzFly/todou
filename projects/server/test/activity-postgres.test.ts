import { decodeMultiCursor } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Cross-project activity on real postgres (T-93): PGlite's `now()` stops
 * at milliseconds, so only a real server exercises the microsecond
 * timestamps the per-project positions inside an envelope must resume
 * through. Comments are written back-to-back on purpose — sub-millisecond
 * neighbors are exactly what the in-memory suite cannot produce. Skipped
 * unless TODOU_TEST_POSTGRES_URL points at a server (see
 * timeline-postgres.test.ts for the invocation).
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("cross-project activity on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  // The database persists across runs; unique slugs isolate each one.
  const run = Date.now().toString(36);
  const pa = `xpg-a-${run}`;
  const pb = `xpg-b-${run}`;
  let issueA = 0;
  let issueB = 0;

  const headers = () => ({ "content-type": "application/json", cookie });
  const cross = async (params: Record<string, string>) =>
    t.app.request(`/api/activity?${new URLSearchParams(params)}`, {
      headers: { cookie },
    });
  const keyOf = (i: { project: string; type: string; id: number }) =>
    `${i.project}/${i.type}/${i.id}`;

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    for (const [slug, name] of [
      [pa, "Cross A (postgres)"],
      [pb, "Cross B (postgres)"],
    ]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ slug, name }),
      });
      expect(res.status).toBe(201);
    }
    const mkIssue = async (slug: string) => {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: "probe" }),
      });
      expect(res.status).toBe(201);
      return (await json(res)).number as number;
    };
    issueA = await mkIssue(pa);
    issueB = await mkIssue(pb);
    // Alternate projects with no settling delay: organic timestamps land
    // microseconds apart, sometimes inside the same millisecond.
    for (let i = 0; i < 6; i++) {
      const slug = i % 2 === 0 ? pa : pb;
      const issue = i % 2 === 0 ? issueA : issueB;
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ body: `c${i}` }),
        },
      );
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("drains exactly-once through envelopes despite µs-tight neighbors", async () => {
    const full = await json(await cross({ projects: `${pa},${pb}` }));
    expect(full.items.length).toBe(8); // 2 opened + 6 comments
    const positions = await decodeMultiCursor(full.next_cursor);
    expect(Object.keys(positions ?? {})).toEqual([pa, pb]);

    const drained: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const body = await json(
        await cross({
          projects: `${pa},${pb}`,
          limit: "3",
          ...(after === undefined ? {} : { after }),
        }),
      );
      if (body.items.length === 0) break;
      drained.push(...body.items.map(keyOf));
      after = body.next_cursor;
      if (body.has_more === false) break;
    }
    expect(drained).toEqual(full.items.map(keyOf));
  });

  it("resumes from a mid-stream envelope without repeating its page", async () => {
    const first = await json(
      await cross({ projects: `${pa},${pb}`, limit: "5" }),
    );
    const rest = await json(
      await cross({ projects: `${pa},${pb}`, after: first.next_cursor }),
    );
    const seen = new Set(first.items.map(keyOf));
    for (const item of rest.items) {
      expect(seen.has(keyOf(item))).toBe(false);
    }
    expect(first.items.length + rest.items.length).toBe(8);
  });
});
