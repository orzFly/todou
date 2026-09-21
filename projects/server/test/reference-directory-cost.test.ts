import { beforeAll, describe, expect, it } from "vitest";
import { projects } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  countStatements,
  makeTestApp,
  type PlacementMode,
  type StatementLog,
} from "./helpers.ts";

/**
 * What `GET /api/me/reference-directory` costs against the number of projects
 * in the registry, and how many statements the prefix half of it takes.
 *
 * Authentication is a session cookie rather than a PAT on purpose: `auth/pat`
 * refreshes `last_used_at` at most once per 60s, so the first request with a
 * token pays one `update tokens` that the second one does not, and every
 * "two reads cost the same" assertion here would fail for a reason that has
 * nothing to do with this endpoint. `validateSession` writes only when a
 * session is close to expiry, which a fixture's never is. The cookie identity
 * is the instance admin, so `accessibleProjectRows` reads the registry
 * outright and N is varied by building a bigger fixture, not by membership.
 *
 * Of the three counting mechanisms in this repo — counting CALLS of a funnel
 * function (test/blocks-read-cost.test.ts), counting statements against ONE
 * database through `session.prepareQuery` (test/metadata.test.ts) and the
 * url-attributed `StatementLog` — this file uses the third.
 *
 * No absolute totals are asserted: a neighbouring card may fold
 * `accessibleProjectRows` into a single query, and hard-coding the count here
 * would punish that fix with a red test.
 */

type Measurement = {
  log: StatementLog;
  /** Distinct databases the registry's project rows resolve to. */
  k: number;
  /** Those urls, minus the system one, so an unread bucket still counts. */
  projectUrls: string[];
  systemUrl: string;
};

/** One app, `n` projects each holding a prefix, one directory read counted. */
async function measure(
  placement: PlacementMode,
  n: number,
): Promise<Measurement> {
  const t = await makeTestApp(placement);
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    for (let i = 0; i < n; i++) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: `pr-${i}`,
          name: `Project ${i}`,
          ref_prefix: `P${i}`,
        }),
      });
      expect(res.status).toBe(201);
    }

    // k is read back off the router the way the service routes, and through
    // `routeInfoOf`, because a hand-built `{ id, slug, database_url }` is the
    // very mistake this card is closing. Under "shared" the project rows
    // resolve to the system url itself, so k is 1, not 0.
    const rows = await t.ctx.router.system().select().from(projects);
    const urls = new Set(
      rows.map((row) => t.ctx.router.resolveProjectUrl(routeInfoOf(row))),
    );
    const systemUrl = t.ctx.config.database.system;

    const log = await countStatements(t, async () => {
      const res = await t.app.request("/api/me/reference-directory", {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
    });
    return {
      log,
      k: urls.size,
      projectUrls: [...urls].filter((url) => url !== systemUrl),
      systemUrl,
    };
  } finally {
    await t.cleanup();
  }
}

/**
 * Per-database counts, system's own excluded. Read off the urls rather than
 * off `byUrl`, because a database nothing was sent to has no key there and
 * would silently drop out of the comparison.
 */
const projectBuckets = (m: Measurement): number[] =>
  m.projectUrls.map((url) => m.log.byUrl[url] ?? 0).sort((a, b) => a - b);

const prefixStatements = (m: Measurement) =>
  m.log.statements.filter((s) => s.sql.includes("ref_prefixes"));

/**
 * The handler only ever touches the system handle: `accessibleProjectRows`,
 * the prefix query and the slug query all run there, and nothing loops over
 * the readable projects. A project database therefore answers nothing.
 */
const PROJECT_BUCKET_STATEMENTS = 0;

describe("reading the reference directory, shared placement (k = 1)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("shared", 4);
    m8 = await measure("shared", 8);
  }, 300_000);

  // No per-bucket assertion in this tier: the system url and the project urls
  // are the same string here, so `byUrl` has a single key.
  it("regression watchdog: sends the same statements for 8 projects as for 4", () => {
    // Green on the parent commit too — this endpoint was already flat in N.
    // It guards against a later change hanging a per-project query off it.
    expect(m4.k).toBe(1);
    expect(m8.k).toBe(1);
    expect(m8.log.total).toBe(m4.log.total);
  });
});

describe("reading the reference directory, dedicated-bucketed placement (k = 2)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("dedicated-bucketed", 4);
    m8 = await measure("dedicated-bucketed", 8);
  }, 300_000);

  it("regression watchdog: sends the same statements, and the same per bucket, for 8 as for 4", () => {
    // Green on the parent commit too, both halves of it.
    expect(m4.k).toBe(2);
    expect(m8.k).toBe(2);
    expect(m8.log.total).toBe(m4.log.total);
    expect(m8.log.byUrl[m8.systemUrl]).toBe(m4.log.byUrl[m4.systemUrl]);
    expect(projectBuckets(m8)).toEqual(projectBuckets(m4));
    expect(projectBuckets(m8)).toEqual([
      PROJECT_BUCKET_STATEMENTS,
      PROJECT_BUCKET_STATEMENTS,
    ]);
  });

  it("reads a prefix and the slug holding it in one statement", () => {
    // Red on the parent commit on the second half: the prefix directory was
    // built from two selects, one over `ref_prefixes` and one over
    // `projects`, paired up in JS. One statement over `ref_prefixes` was
    // already true then, so only the join makes this pass.
    for (const m of [m4, m8]) {
      const prefixed = prefixStatements(m);
      expect(prefixed).toHaveLength(1);
      expect(prefixed[0]?.sql).toContain('"projects"');
    }
  });
});

describe("reading the reference directory, dedicated placement (k = N)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("dedicated", 4);
    m8 = await measure("dedicated", 8);
  }, 300_000);

  // The whole-request equality is false by construction under k = N, so it is
  // deliberately not asserted here.
  it("regression watchdog: the system database's share is flat in N, and no project database is read", () => {
    // Both halves are green on the parent commit: the handler never had a
    // per-project loop, and neither did `accessibleProjectRows`.
    expect(m4.k).toBe(4);
    expect(m8.k).toBe(8);
    expect(m8.log.byUrl[m8.systemUrl]).toBe(m4.log.byUrl[m4.systemUrl]);
    expect(projectBuckets(m4)).toEqual(
      Array.from({ length: 4 }, () => PROJECT_BUCKET_STATEMENTS),
    );
    expect(projectBuckets(m8)).toEqual(
      Array.from({ length: 8 }, () => PROJECT_BUCKET_STATEMENTS),
    );
    expect((m8.log.total - m4.log.total) / 4).toBe(PROJECT_BUCKET_STATEMENTS);
  });
});
