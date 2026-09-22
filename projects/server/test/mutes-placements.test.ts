import { describe, expect, it } from "vitest";
import { accessibleProjectRows } from "../src/services/access.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type PlacementMode,
  type StatementLog,
  type TestApp,
} from "./helpers.ts";

/**
 * Every case in this file is a regression watchdog: `/api/me/mutes` already
 * grouped by database before `perDatabase` existed, so none of these numbers
 * moves from red to green with this card. What they guard is that the shared
 * helper does not turn a constant into something that grows with the project
 * count, and that `/api/me/mutes` has any coverage at all away from
 * `placement=shared`, where until now it had none.
 *
 * The fixture spends one uncounted `GET /api/me/mutes` before measuring:
 * `verifyPat` refreshes `tokens.last_used_at` at most once a minute, so the
 * first request on a fresh PAT carries one extra system statement. Drop that
 * warm-up and every count below reads one higher — the system half goes 4 to
 * 5 — which is how to falsify this paragraph. For the same reason none of the
 * counted cases plants a mute first: that write would warm the throttle on
 * its own and leave the warm-up here doing nothing.
 *
 * SYSTEM_STATEMENTS = 4
 *   = verifyPat's tokens ⋈ users (the last_used_at update is warmed away)
 *   + accessibleProjectRows' two (project_members, then projects; an
 *     instance admin would take one, which is why bob is a plain member)
 *   + loadMutedProjects' one
 *   (the projectMutes read fires only when a project-level mute exists, and
 *   this fixture plants none)
 * PER_GROUP_STATEMENTS = 1
 *   = the issue_mutes ⋈ issues join, one per database and independent of how
 *     many projects that database holds
 */
const SYSTEM_STATEMENTS = 4;
const PER_GROUP_STATEMENTS = 1;

type Fixture = {
  t: TestApp;
  /** A plain member, not an instance admin: see SYSTEM_STATEMENTS. */
  bob: Awaited<ReturnType<typeof addUserWithToken>>;
  /** Project slugs in the order `accessibleProjectRows` hands them back. */
  scope: string[];
  /** Resolved database url per slug, read back off the router. */
  urlOf: Map<string, string>;
  systemUrl: string;
};

async function setUp(placement: PlacementMode, n: number): Promise<Fixture> {
  const t = await makeTestApp(placement);
  const cookie = await t.login();
  const headers = { "content-type": "application/json", cookie };
  const bob = await addUserWithToken(t.ctx, "mutes-bob");

  for (let i = 0; i < n; i++) {
    const slug = `mut-${i}`;
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
    const issue = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `card in ${slug}` }),
    });
    expect(issue.status).toBe(201);
  }

  // Which ids the system database handed out is not ours to assume, so the
  // bucketing is read back through the router the way listMutes resolves it.
  const rows = await accessibleProjectRows(t.ctx, bob.user);
  const urlOf = new Map<string, string>();
  for (const row of rows) {
    urlOf.set(
      row.slug,
      t.ctx.router.resolveProjectUrl({
        id: row.id,
        slug: row.slug,
        database_url: row.databaseUrl,
      }),
    );
  }
  expect(urlOf.size).toBe(n);

  // Uncounted, and the only bob-authenticated request before a measurement:
  // it absorbs the one-per-minute `tokens.last_used_at` refresh so the
  // numbers below are the steady state rather than a first-call state.
  const warm = await t.app.request("/api/me/mutes", { headers: bob.headers });
  expect(warm.status).toBe(200);

  return {
    t,
    bob,
    scope: rows.map((r) => r.slug),
    urlOf,
    systemUrl: t.ctx.config.database.system,
  };
}

async function mute(f: Fixture, slug: string): Promise<void> {
  const res = await f.t.app.request(`/api/projects/${slug}/issues/1/mute`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...f.bob.headers },
    body: JSON.stringify({ mode: "forever" }),
  });
  expect(res.status).toBe(204);
}

async function listMutesOf(
  f: Fixture,
): Promise<{ issues: { project: { slug: string }; number: number }[] }> {
  const res = await f.t.app.request("/api/me/mutes", {
    headers: f.bob.headers,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    issues: { project: { slug: string }; number: number }[];
  };
}

function countMutes(f: Fixture): Promise<StatementLog> {
  return countStatements(f.t, () => listMutesOf(f));
}

/** Distinct project databases, which is the k the criterion is stated in. */
function bucketsOf(f: Fixture): string[] {
  return [...new Set(f.urlOf.values())].filter((u) => u !== f.systemUrl);
}

describe("mutes across placements", () => {
  it("watchdog: groups by database and keeps a group's rows together", async () => {
    const f = await setUp("dedicated-bucketed", 4);
    try {
      // Two projects on one database with a project from the other database
      // sitting between them in scope order — without that separation the
      // adjacency assertion below would still hold if grouping were dropped
      // entirely, because the two would already be neighbours.
      const together = [...f.urlOf.values()]
        .map((url) => f.scope.filter((s) => f.urlOf.get(s) === url))
        .find((members) => members.length >= 2);
      if (!together) throw new Error("no two projects share a database");
      const [first, second] = [together[0] as string, together[1] as string];
      const between = f.scope
        .slice(f.scope.indexOf(first) + 1, f.scope.indexOf(second))
        .find((s) => f.urlOf.get(s) !== f.urlOf.get(first));
      if (!between) throw new Error("the shared pair has no outsider between");

      for (const slug of [first, second, between]) await mute(f, slug);

      const { issues } = await listMutesOf(f);
      expect(issues).toHaveLength(3);
      for (const row of issues) expect(row.number).toBe(1);
      const at = (slug: string) =>
        issues.findIndex((row) => row.project.slug === slug);
      expect(at(first)).toBeGreaterThanOrEqual(0);
      expect(at(second)).toBeGreaterThanOrEqual(0);
      expect(at(between)).toBeGreaterThanOrEqual(0);
      expect(Math.abs(at(first) - at(second))).toBe(1);
    } finally {
      await f.t.cleanup();
    }
  });

  it("watchdog: shared spends the same statements at N=4 and N=8", async () => {
    // k ≡ 1 here, and it is the degenerate rung: the projects resolve to the
    // system url itself, so `byUrl` has a single key and the project half
    // cannot be told from the system half. Only the total is assertable.
    const small = await setUp("shared", 4);
    let four: StatementLog;
    try {
      four = await countMutes(small);
      expect(bucketsOf(small)).toEqual([]);
      // Pinned absolutely, not just against the N=8 side: the equality alone
      // survives anything that costs both fixtures the same, the dropped
      // warm-up included, and this rung has no bucket split to catch that.
      expect(four.total).toBe(SYSTEM_STATEMENTS + PER_GROUP_STATEMENTS);
    } finally {
      await small.t.cleanup();
    }

    // One fixture at a time: three PGlite instances per bucketed app is
    // enough that holding two live apps turns this suite into an OOM rather
    // than a failed assertion.
    const big = await setUp("shared", 8);
    try {
      const eight = await countMutes(big);
      expect(eight.total).toBe(four.total);
      expect(Object.keys(eight.byUrl)).toHaveLength(1);
    } finally {
      await big.t.cleanup();
    }
  });

  it("watchdog: dedicated-bucketed spends the same statements at N=4 and N=8", async () => {
    const measure = async (n: number) => {
      const f = await setUp("dedicated-bucketed", n);
      try {
        expect(bucketsOf(f)).toHaveLength(2);
        const log = await countMutes(f);
        expect(log.byUrl[f.systemUrl]).toBe(SYSTEM_STATEMENTS);
        for (const url of bucketsOf(f)) {
          expect(log.byUrl[url]).toBe(PER_GROUP_STATEMENTS);
        }
        return log.total;
      } finally {
        await f.t.cleanup();
      }
    };
    expect(await measure(8)).toBe(await measure(4));
  }, 30_000);

  it("watchdog: dedicated keeps the system half flat and each bucket constant", async () => {
    // k ≡ N on this rung, so the whole-request equality is false by
    // construction and is deliberately not asserted. N is 2 and 4 rather
    // than 4 and 8 because a dedicated fixture costs ~2s per project, and
    // N=8 alone would sit on the 20s default timeout.
    const measure = async (n: number) => {
      const f = await setUp("dedicated", n);
      try {
        expect(bucketsOf(f)).toHaveLength(n);
        const log = await countMutes(f);
        for (const url of bucketsOf(f)) {
          expect(log.byUrl[url]).toBe(PER_GROUP_STATEMENTS);
        }
        return { system: log.byUrl[f.systemUrl], total: log.total };
      } finally {
        await f.t.cleanup();
      }
    };
    const four = await measure(4);
    const two = await measure(2);
    expect(four.system).toBe(SYSTEM_STATEMENTS);
    expect(two.system).toBe(four.system);
    expect((four.total - two.total) / 2).toBe(PER_GROUP_STATEMENTS);
  }, 40_000);
});
