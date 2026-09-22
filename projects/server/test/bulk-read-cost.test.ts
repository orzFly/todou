import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "../src/services/access.ts";
import { ensureFrontiers } from "../src/services/reads.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  PLACEMENTS,
  type PlacementMode,
  type StatementLog,
  type TestApp,
} from "./helpers.ts";

/**
 * What `PUT /api/me/read` costs against the number of projects the caller
 * can write to, and in what order the two multi-row writes to
 * `read_frontiers` take their rows.
 *
 * Three counting mechanisms now live in this repo, each for a different
 * question. test/blocks-read-cost.test.ts uses `vi.mock` to count CALLS of
 * `blocksForIssues`, which needs a single known funnel function to exist.
 * test/metadata.test.ts' `countQueries` wraps one handle's
 * `session.prepareQuery` and counts STATEMENTS ON ONE DATABASE, with no url
 * attribution and no sight of the system database. This file counts the
 * queries drizzle issues ON EVERY DATABASE, attributed to the resolved url —
 * "one transaction per database rather than per project" has no single funnel
 * function, and cross-database attribution is only visible at the driver.
 * As in test/blocks-read-cost.test.ts, the assertion is the statement COUNT,
 * not a duration.
 *
 * The counting rules, the definition of k and what each tier can prove are in
 * the plan's acceptance section. Absolute counts are recorded in the commit
 * message rather than here: they move whenever a neighbouring card changes an
 * unrelated query, so every assertion below is relative.
 */

/** Statements this endpoint sends once per database, never once per project. */
const SWEEP_UPDATE = /update "issue_reads"/;
const SWEEP_UPSERT = /insert into "read_frontiers"/;

/** Per project database: the sweep's UPDATE and its frontier upsert. */
const STATEMENTS_PER_GROUP = 2;

const matching = (log: StatementLog, re: RegExp) =>
  log.statements.filter((s) => re.test(s.sql));

type Window = {
  k: number;
  rows: ProjectRow[];
  /** Deduplicated project urls, system url included when it is one of them. */
  urls: string[];
  /** `PUT /api/me/read` with `{}` — what the web client's button sends. */
  omitted: StatementLog;
  /** The same call naming every reachable slug, as an API caller would. */
  listed: StatementLog;
};

async function measure(
  t: TestApp,
  who: Record<string, string>,
  user: UserRow,
  slugs: string[],
): Promise<Window> {
  const call = (body: unknown) =>
    t.app.request("/api/me/read", {
      method: "PUT",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify(body),
    });
  const window = async (body: unknown): Promise<StatementLog> => {
    // Warm-up outside the window because of the PAT's `last_used_at`
    // throttle (auth/pat.ts, 60s): the first call of a window would other-
    // wise carry an extra `update "tokens"` the second one does not.
    const warm = await call(body);
    expect(warm.status).toBe(204);
    let status = 0;
    const log = await countStatements(t, async () => {
      status = (await call(body)).status;
    });
    expect(status).toBe(204);
    return log;
  };

  const omitted = await window({});
  const listed = await window({ projects: slugs });

  // k is read back off the router the way the service routes, rather than
  // rebuilt from the url template — and through `routeInfoOf`, because a
  // hand-built `{ id, slug, database_url }` is the very mistake this card
  // is closing and a test must not demonstrate it.
  const rows = await accessibleProjectRows(t.ctx, user);
  const urls = [
    ...new Set(rows.map((r) => t.ctx.router.resolveProjectUrl(routeInfoOf(r)))),
  ];
  return { k: urls.length, rows, urls, omitted, listed };
}

/** One row per resolved url, for reading each database back afterwards. */
function oneRowPerUrl(t: TestApp, rows: ProjectRow[]): ProjectRow[] {
  const seen = new Map<string, ProjectRow>();
  for (const row of rows) {
    const url = t.ctx.router.resolveProjectUrl(routeInfoOf(row));
    if (!seen.has(url)) seen.set(url, row);
  }
  return [...seen.values()];
}

async function frontierRows(t: TestApp, rows: ProjectRow[], userId: number) {
  let total = 0;
  for (const row of oneRowPerUrl(t, rows)) {
    const db = await t.ctx.router.forProject(routeInfoOf(row));
    const got = await db.execute(
      sql`select count(*)::int as n from read_frontiers
          where user_id = ${userId}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: driver-agnostic result shape
    const result = (got as any).rows ?? got;
    total += Number(result[0].n);
  }
  return total;
}

describe.each(PLACEMENTS)(
  "PUT /api/me/read statement count (%s)",
  (placement: PlacementMode) => {
    let t: TestApp;
    let bob: Awaited<ReturnType<typeof addUserWithToken>>;
    let small: Window;
    let big: Window;
    let systemUrl: string;

    beforeAll(async () => {
      t = await makeTestApp(placement);
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      // A plain member, not the cookie account: `accessibleProjectRows`
      // hands an instance admin the whole projects table, which would make
      // the two windows below see the same N.
      bob = await addUserWithToken(t.ctx, "brc-bob");
      const slugs = Array.from({ length: 8 }, (_, i) => `brc-p${i}`);
      for (const slug of slugs) {
        const created = await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug.toUpperCase() }),
        });
        expect(created.status).toBe(201);
      }
      const seat = async (slug: string) => {
        const member = await t.app.request(
          `/api/projects/${slug}/members/${bob.user.id}`,
          { method: "PUT", headers, body: JSON.stringify({ role: "writer" }) },
        );
        expect(member.status).toBe(204);
      };
      for (const slug of slugs.slice(0, 4)) await seat(slug);
      small = await measure(t, bob.headers, bob.user, slugs.slice(0, 4));
      // Seating the other four happens between the windows, never inside
      // one: those statements are not part of what a sweep costs.
      for (const slug of slugs.slice(4)) await seat(slug);
      big = await measure(t, bob.headers, bob.user, slugs);
      systemUrl = t.ctx.router.systemHandle().url;
    }, 300_000);

    afterAll(async () => {
      await t?.cleanup();
    });

    it("both windows saw the project counts and the k this tier promises", () => {
      expect(small.rows).toHaveLength(4);
      expect(big.rows).toHaveLength(8);
      const expected = { shared: 1, "dedicated-bucketed": 2, dedicated: 8 };
      expect(big.k).toBe(expected[placement]);
      expect(small.k).toBe(placement === "dedicated" ? 4 : expected[placement]);
    });

    it("sends the sweep's two statements once per database", () => {
      for (const window of [small, big]) {
        for (const log of [window.omitted, window.listed]) {
          // Statement shape rather than url buckets: under `shared` the
          // group's database IS the system handle, so `byUrl` has one key.
          expect(matching(log, SWEEP_UPDATE)).toHaveLength(window.k);
          expect(matching(log, SWEEP_UPSERT)).toHaveLength(window.k);
        }
      }
    });

    it.skipIf(placement === "shared")(
      "keeps the sweep off the system database",
      () => {
        for (const window of [small, big]) {
          for (const log of [window.omitted, window.listed]) {
            for (const re of [SWEEP_UPDATE, SWEEP_UPSERT]) {
              expect(matching(log, re).map((s) => s.url === systemUrl)).toEqual(
                matching(log, re).map(() => false),
              );
            }
          }
        }
      },
    );

    it.skipIf(placement === "dedicated")(
      "costs the same at N=8 as at N=4",
      () => {
        expect(big.omitted.total).toBe(small.omitted.total);
        expect(big.listed.total).toBe(small.listed.total);
      },
    );

    it.runIf(placement === "dedicated-bucketed")(
      "spends the same per database and on the system database",
      () => {
        const buckets = (w: Window, log: StatementLog) =>
          w.urls.map((url) => log.byUrl[url] ?? 0).sort((a, b) => a - b);
        expect(buckets(big, big.omitted)).toEqual(
          buckets(small, small.omitted),
        );
        expect(buckets(big, big.listed)).toEqual(buckets(small, small.listed));
        expect(big.omitted.byUrl[systemUrl]).toBe(
          small.omitted.byUrl[systemUrl],
        );
      },
    );

    it.runIf(placement === "dedicated")(
      "watchdog: one database per project still costs c statements per project",
      () => {
        // The whole-request equality is false by construction at k == N and
        // is not asserted. What is left is a slope: each extra project adds
        // exactly its own two statements (the sweep's UPDATE and its
        // frontier upsert — begin/commit are `txControl` and PGlite never
        // hands them to the logger anyway), and the system database answers
        // the `{}` body at a cost that does not move with N. Green before
        // this card too, hence the name: it guards the slope, it does not
        // claim it.
        expect(big.omitted.total - small.omitted.total).toBe(
          STATEMENTS_PER_GROUP * 4,
        );
        expect(big.omitted.byUrl[systemUrl]).toBe(
          small.omitted.byUrl[systemUrl],
        );
      },
    );

    it("regression watchdog: every project in scope was swept", async () => {
      // Green on the parent commit and green after: its only job is to catch
      // a per-database rollup that drops a project on the floor, which is
      // the cheapest way to make every count above look better. It proves
      // nothing about the cost.
      expect(await frontierRows(t, big.rows, bob.user.id)).toBe(8);
    });
  },
);

describe("read_frontiers is written in one row order everywhere", () => {
  // Runs on `shared` alone: the row order inside a multi-row write is only
  // observable where one database holds several of the caller's projects,
  // and a deadlock needs two writers holding rows of the same table anyway.
  let t: TestApp;
  let bob: Awaited<ReturnType<typeof addUserWithToken>>;
  let sortedIds: number[];

  beforeAll(async () => {
    t = await makeTestApp("shared");
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    bob = await addUserWithToken(t.ctx, "brl-bob");
    for (const slug of ["brl-p0", "brl-p1", "brl-p2"]) {
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
    const rows = await accessibleProjectRows(t.ctx, bob.user);
    sortedIds = rows.map((r) => r.id).sort((a, b) => a - b);
    expect(sortedIds).toHaveLength(3);
  }, 120_000);

  afterAll(async () => {
    await t?.cleanup();
  });

  it("takes the sweep's frontier rows by ascending project id", async () => {
    const log = await countStatements(t, async () => {
      const res = await t.app.request("/api/me/read", {
        method: "PUT",
        headers: { "content-type": "application/json", ...bob.headers },
        // The slugs are named in descending id order on purpose, and an
        // explicit list rather than `{}`: the `{}` path takes its scope from
        // `accessibleProjectRows`, whose `where id in (…)` already hands back
        // ascending order, so this assertion would hold with the sort under
        // test deleted. `requireCapabilities` instead pushes one row per ref
        // in the client's own order, which is the order that reaches the
        // multi-row upsert — so only this shape can witness the sort.
        body: JSON.stringify({ projects: ["brl-p2", "brl-p1", "brl-p0"] }),
      });
      expect(res.status).toBe(204);
    });
    const upserts = matching(log, SWEEP_UPSERT);
    expect(upserts).toHaveLength(1);
    const upsert = upserts[0] as (typeof upserts)[number];
    // Length first: it is the guard that makes the stride below safe to
    // read. Measured on drizzle-orm 0.45.2 — the sweep's upsert binds
    // (project_id, user_id) per row and nothing at the tail while `up_to`
    // is absent, so a drizzle change that reshapes the row has to fail
    // here rather than silently read slot 0 of the wrong tuple.
    expect(upsert.params).toHaveLength(2 * sortedIds.length);
    expect(upsert.params.filter((_, i) => i % 2 === 0)).toEqual(sortedIds);
  });

  it("takes ensureFrontiers' rows by ascending project id too", async () => {
    const rows = await accessibleProjectRows(t.ctx, bob.user);
    const db = await t.ctx.router.forProject(
      routeInfoOf(rows[0] as ProjectRow),
    );
    // `read_frontiers.project_id` is a bare bigint with no foreign key, so
    // ids that belong to no project are enough to watch the ordering.
    const base = Math.max(...sortedIds) + 1000;
    const log = await countStatements(t, async () => {
      await ensureFrontiers(db, [base + 2, base, base + 1], bob.user.id);
    });
    const inserts = matching(log, SWEEP_UPSERT);
    expect(inserts).toHaveLength(1);
    const insert = inserts[0] as (typeof inserts)[number];
    // Three params per row here — (project_id, user_id, frontier_at) —
    // where the sweep binds two; same length-then-stride guard.
    expect(insert.params).toHaveLength(3 * 3);
    expect(insert.params.filter((_, i) => i % 3 === 0)).toEqual([
      base,
      base + 1,
      base + 2,
    ]);
  });
});
