import { describe, expect, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { accessibleProjectRows, routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type PlacementMode,
} from "./helpers.ts";

/**
 * The warm-up request is load-bearing for the cards, not for the counts:
 * without it bob has no frontier yet, the cards below are dated before his
 * epoch and arrive already read, so `items` drops to 0 while the totals stay
 * equal (measured 27 == 27). It also happens to move `ensureFrontiers`' lazy
 * seeding out of the measured window (27 then 22 without it, 35 both times
 * with it) — true, but not the reason it is here.
 *
 * Three counting mechanisms now live in this repo, each for a different
 * question. test/blocks-read-cost.test.ts uses `vi.mock` to count CALLS of
 * `blocksForIssues`, which needs a single known funnel function to exist.
 * test/metadata.test.ts' `countQueries` wraps one handle's
 * `session.prepareQuery` and counts STATEMENTS ON ONE DATABASE, with no url
 * attribution and no sight of the system database. This file counts the
 * queries drizzle issues ON EVERY DATABASE, attributed to the resolved url —
 * "one statement per group rather than per project" has no single funnel
 * function, and cross-database attribution is only visible at the driver.
 *
 * The `?projects=` path is deliberately absent here. On this same fixture it
 * costs 41 statements at n=4 (system bucket 16) and 49 at n=8 (system bucket
 * 24) — two extra system statements per named slug, project buckets
 * unchanged. Those are the handover numbers; the red-to-green case for them
 * belongs to test/auth-statement-count.test.ts, and nothing here may pin
 * today's per-slug fan-out as expected behaviour.
 */

/**
 * Every project but the first is empty, so the per-card cost is a constant
 * and the only thing varying between n=4 and n=8 is the project count.
 */
async function measure(placement: PlacementMode, n: number) {
  const t = await makeTestApp(placement);
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    const bob = await addUserWithToken(t.ctx, "count-bob");
    // Slugs always carry a letter: an all-digit ref sends findProjectByRef
    // down its ID branch and costs an extra select.
    const slugs = Array.from({ length: n }, (_, i) => `cnt-p${i}`);
    for (const slug of slugs) {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, name: slug.toUpperCase() }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${slug}/members/${bob.user.id}`,
        { method: "PUT", headers, body: JSON.stringify({ role: "writer" }) },
      );
      expect(member.status).toBe(204);
    }

    const warm = await t.app.request("/api/me/inbox", { headers: bob.headers });
    expect(warm.status).toBe(200);

    const loadedSlug = slugs[0] as string;
    for (const title of ["first news", "second news"]) {
      const res = await t.app.request(`/api/projects/${loadedSlug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
    }

    let status = 0;
    let items = -1;
    const log = await countStatements(t, async () => {
      const res = await t.app.request("/api/me/inbox", {
        headers: bob.headers,
      });
      status = res.status;
      items = ((await res.json()) as { items: unknown[] }).items.length;
    });

    const systemUrl = t.ctx.config.database.system;
    const rows = await accessibleProjectRows(t.ctx, bob.user);
    const urlOf = new Map<string, string>();
    for (const row of rows) {
      urlOf.set(row.slug, t.ctx.router.resolveProjectUrl(routeInfoOf(row)));
    }
    const projectUrls = new Set(urlOf.values());
    projectUrls.delete(systemUrl);
    const loadedUrl = urlOf.get(loadedSlug) as string;

    // The control runs while this app is still alive; after cleanup the
    // router is closed and nothing can be measured off it.
    const control = await countStatements(t, async () => {
      for (const row of rows) {
        const db = await t.ctx.router.forProject(routeInfoOf(row));
        await db.select().from(issues).limit(1);
      }
    });

    return {
      total: log.total,
      system: log.byUrl[systemUrl] ?? 0,
      buckets: [...projectUrls]
        .map((url) => log.byUrl[url] ?? 0)
        .sort((a, b) => a - b),
      emptyBuckets: [...projectUrls]
        .filter((url) => url !== loadedUrl)
        .map((url) => log.byUrl[url] ?? 0)
        .sort((a, b) => a - b),
      loaded: log.byUrl[loadedUrl] ?? 0,
      keys: Object.keys(log.byUrl),
      projectUrls,
      systemUrl,
      items,
      status,
      control: control.total,
    };
  } finally {
    await t.cleanup();
  }
}

/**
 * Every empty project costs this much of the candidate scan: the frontier
 * read, the newest comment time, the unread issue ids, the newest
 * issue_events time, the issue_events count, the open issue ids (joined to
 * statuses), and the newest issue_mentions time. With no rows the endpoint
 * returns early and never reaches hydration. If any change legitimately
 * lowers the single-project read cost, update this constant and rewrite the
 * breakdown in the same commit — this is the only place the whole suite
 * would notice a per-project regression under `dedicated`.
 */
const EMPTY_PROJECT_STATEMENTS = 7;

describe("/api/me/inbox statement count", () => {
  it("regression watchdog (shared): /api/me/inbox already costs the same at N=4 and N=8", async () => {
    const small = await measure("shared", 4);
    const big = await measure("shared", 8);
    for (const m of [small, big]) {
      expect(m.status).toBe(200);
      expect(m.items).toBe(2);
    }
    expect(big.total).toBe(small.total);
    // Under `shared` the projects resolve back to the system url, so byUrl
    // has a single key and cannot tell system statements from project ones —
    // no per-database attribution is asserted in this tier.
    expect(small.keys).toEqual([small.systemUrl]);
    expect(big.keys).toEqual([big.systemUrl]);
  }, 120_000);

  it("regression watchdog (dedicated-bucketed): total and every bucket hold at N=4 and N=8", async () => {
    const small = await measure("dedicated-bucketed", 4);
    const big = await measure("dedicated-bucketed", 8);
    for (const m of [small, big]) {
      expect(m.status).toBe(200);
      expect(m.items).toBe(2);
    }
    expect(big.total).toBe(small.total);
    expect(big.system).toBe(small.system);
    // Compared as a sorted multiset of counts, not by url: each app runs
    // under its own run prefix, so the urls themselves never match.
    expect(big.buckets).toEqual(small.buckets);
    for (const m of [small, big]) {
      expect(m.keys).toContain(m.systemUrl);
      for (const key of m.keys) {
        expect(key === m.systemUrl || m.projectUrls.has(key)).toBe(true);
      }
    }
  }, 120_000);

  it("regression watchdog (dedicated): the system bucket and the per-project constant do not grow with N", async () => {
    // N=2 and N=4 rather than 4 and 8: under `dedicated` N=8 means nine
    // PGlite instances, well past the 3 GB per fork that vitest.config.ts
    // budgets. The slope being measured is the same either way.
    const small = await measure("dedicated", 2);
    const big = await measure("dedicated", 4);
    for (const m of [small, big]) {
      expect(m.status).toBe(200);
      expect(m.items).toBe(2);
    }
    // The whole-request equality is false by construction here and is not
    // asserted; only the system half and the per-project constant are.
    expect(big.system).toBe(small.system);
    expect(big.loaded).toBe(small.loaded);
    for (const m of [small, big]) {
      expect(m.emptyBuckets).toEqual(
        m.emptyBuckets.map(() => EMPTY_PROJECT_STATEMENTS),
      );
      expect(m.emptyBuckets).toHaveLength(m.projectUrls.size - 1);
    }
    expect((big.total - small.total) / 2).toBe(EMPTY_PROJECT_STATEMENTS);
  }, 120_000);

  it("control: a hand-written per-project loop does double with N", async () => {
    const small = await measure("dedicated-bucketed", 4);
    const big = await measure("dedicated-bucketed", 8);
    expect(big.control).toBe(2 * small.control);
  }, 120_000);
});
