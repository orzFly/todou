import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { issueEvents, issues, statuses } from "../src/db/project-schema.ts";
import { issueBlocks, projects, refPrefixes } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { repairBlocks } from "../src/services/blocks.ts";
import { syncRefPrefixMirror } from "../src/services/reference-directory.ts";
import {
  countStatements,
  makeTestApp,
  type PlacementMode,
  type StatementLog,
  type TestApp,
} from "./helpers.ts";

/**
 * What the hourly sweeps cost against the number of projects in the registry.
 *
 * (i) Why statements and not calls. Three counting mechanisms live in this
 * repo and their units differ: `test/blocks-read-cost.test.ts` counts CALLS of
 * a funnel function (its claim, "one `blocksForIssues` per page", happens to
 * land on a function boundary); `test/metadata.test.ts`'s `countQueries` wraps
 * `session.prepareQuery` and counts statements against ONE database; the
 * `countStatements` used here counts url-ATTRIBUTED statements. Only the third
 * can express this file's claim, because "round trips across N project
 * databases" sits on no single function boundary — `perDatabase` calls its
 * callback once per group, so counting calls only recounts k, and k is what
 * the fixture chose rather than what is being proven.
 *
 * (ii) The claim is "flat in N at a fixed amount of drift", not "constant".
 * `announceBlockChanges` calls `landEvent` once per moved edge, and that is a
 * `findProjectByRef` read, an `issues` read and an `issue_events` write —
 * strictly O(moved edges), by design.
 *
 * (iii) `CHUNK` in `blocks.ts` narrows the claim further, to "flat in N while
 * the edge and number counts fit one chunk". Past the chunk size what grows is
 * ⌈rows / CHUNK⌉, still not N.
 *
 * k is the number of distinct databases the registry's PROJECT rows resolve
 * to, system's own excluded, read back off the router rather than rebuilt from
 * the url template. Under "shared" that is 1, not 0: the project rows resolve
 * to the system url itself, which is also why that tier cannot be bucketed.
 */

/** Sweep reads that exist once per sweep, whatever N and k are. */
const SYSTEM_READS = 3; // all edges, projects where id in (…), the pending scan
/** Project-database reads per group: project_meta, statuses, issues. */
const PER_GROUP_READS = 3;
/** `landEvent`: a projects read, an issues read, an issue_events insert. */
const ANNOUNCE_PER_CHANGE = 3;
/** Both drifted edges in the fixture below need the same verdict. */
const VERDICT_BATCHES = 1;
/**
 * The mirror sweep's system-tier statements: the projects scan, the mirror
 * read `where project_id in (…)`, and the merged insert — the last of which
 * exists because every mirror fixture below is built with a gap in it.
 */
const SYNC_SYSTEM = 3;

type Measurement = {
  log: StatementLog;
  k: number;
  systemUrl: string;
};

/** Per-database counts, system's own excluded, comparable across apps. */
const projectBuckets = (m: Measurement): number[] =>
  Object.entries(m.log.byUrl)
    .filter(([url]) => url !== m.systemUrl)
    .map(([, count]) => count)
    .sort((a, b) => a - b);

async function createIssue(
  t: TestApp,
  headers: Record<string, string>,
  slug: string,
  title: string,
): Promise<number> {
  const res = await t.app.request(`/api/projects/${slug}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { number: number }).number;
}

/**
 * One app, N projects of two cards and one edge each, one sweep measured.
 * Measuring and then tearing down inside one call keeps the peak number of
 * live PGlite instances at one, which is what the memory budget in
 * vitest.config.ts is about.
 */
async function measure(
  placement: PlacementMode,
  n: number,
  drift: number,
): Promise<Measurement> {
  const t = await makeTestApp(placement);
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    const edgeIds: number[] = [];
    for (let i = 0; i < n; i++) {
      const slug = `sw-${i}`;
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, name: `Sweep ${i}` }),
      });
      expect(created.status).toBe(201);
      const blocked = await createIssue(t, headers, slug, "blocked");
      const blocker = await createIssue(t, headers, slug, "blocker");
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${blocked}/blocked-by`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ ref: `#${blocker}` }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { blocked_by: { edge_id: number }[] };
      edgeIds.push(body.blocked_by[0]?.edge_id as number);
    }

    const system = t.ctx.router.system();
    // Drift is written straight into the system tier: a PATCH would wake the
    // live `evaluateBlockerStatus` and settle the very disagreement the sweep
    // is supposed to find. Both edges are stamped cleared while their blockers
    // sit in Todo, so both need the SAME verdict (re-block) — which keeps
    // `applyVerdicts` at one batch and, because a re-block is not announced
    // with a `cleared_notified_at` write, keeps the announcement at three
    // statements an edge rather than four.
    const drifted = edgeIds.slice(0, drift);
    if (drifted.length > 0) {
      const now = new Date();
      await system
        .update(issueBlocks)
        .set({ clearedAt: now, clearedNotifiedAt: now })
        .where(inArray(issueBlocks.id, drifted));
    }

    const rows = await system.select().from(projects);
    const k = new Set(
      rows.map((row) => t.ctx.router.resolveProjectUrl(routeInfoOf(row))),
    ).size;

    let recomputed = -1;
    const log = await countStatements(t, async () => {
      recomputed = (await repairBlocks(t.ctx)).recomputed;
    });
    expect(recomputed, "the fixture's drift is what the sweep repaired").toBe(
      drift,
    );
    return { log, k, systemUrl: t.ctx.router.systemHandle().url };
  } finally {
    await t.cleanup();
  }
}

describe("repairBlocks, shared placement (k = 1)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("shared", 4, 0);
    m8 = await measure("shared", 8, 0);
  });

  it("sends the same statements for 8 projects as for 4, with no drift", () => {
    expect(m4.k).toBe(1);
    expect(m8.log.total).toBe(m4.log.total);
    expect(m8.log.total).toBe(SYSTEM_READS + 1 * PER_GROUP_READS);
  });
});

describe("repairBlocks with drift, shared placement (k = 1)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("shared", 4, 2);
    m8 = await measure("shared", 8, 2);
  });

  it("sends the same statements for 8 projects as for 4, at fixed drift", () => {
    expect(m8.log.total).toBe(m4.log.total);
    expect(m8.log.total).toBe(
      SYSTEM_READS +
        1 * PER_GROUP_READS +
        VERDICT_BATCHES +
        2 * ANNOUNCE_PER_CHANGE,
    );
  });
});

describe("repairBlocks, dedicated-bucketed placement (k = 2)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("dedicated-bucketed", 4, 0);
    m8 = await measure("dedicated-bucketed", 8, 0);
  });

  it("sends the same statements, and the same per bucket, for 8 as for 4", () => {
    expect(m4.k).toBe(2);
    expect(m8.log.total).toBe(m4.log.total);
    expect(m8.log.total).toBe(SYSTEM_READS + 2 * PER_GROUP_READS);
    // Bucket urls carry a per-app run prefix, so the two apps share no keys;
    // what has to match is the multiset of counts.
    expect(projectBuckets(m8)).toEqual(projectBuckets(m4));
    expect(projectBuckets(m8)).toEqual([PER_GROUP_READS, PER_GROUP_READS]);
    expect(m8.log.byUrl[m8.systemUrl]).toBe(SYSTEM_READS);
    expect(m4.log.byUrl[m4.systemUrl]).toBe(SYSTEM_READS);
  });
});

describe("repairBlocks with drift, dedicated-bucketed placement (k = 2)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("dedicated-bucketed", 4, 2);
    m8 = await measure("dedicated-bucketed", 8, 2);
  });

  it("sends the same total, and the same from the system tier, for 8 as for 4", () => {
    expect(m8.log.total).toBe(m4.log.total);
    expect(m8.log.byUrl[m8.systemUrl]).toBe(m4.log.byUrl[m4.systemUrl]);
    // Deliberately no per-project-bucket equality here: the announcement lands
    // in the BLOCKED card's database, so bucket-by-bucket equality would only
    // hold while both fixtures happen to drift into the same buckets.
  });
});

describe("repairBlocks, dedicated placement (k = N)", () => {
  let m2: Measurement;
  let m4: Measurement;

  beforeAll(async () => {
    m2 = await measure("dedicated", 2, 0);
    m4 = await measure("dedicated", 4, 0);
  });

  it("keeps the system tier's share flat in N", () => {
    // The whole-request equality is false by construction at k = N, so the
    // system tier's share is the half that can be asserted.
    expect(m2.k).toBe(2);
    expect(m4.k).toBe(4);
    expect(m2.log.byUrl[m2.systemUrl]).toBe(SYSTEM_READS);
    expect(m4.log.byUrl[m4.systemUrl]).toBe(SYSTEM_READS);
  });

  it("regression watchdog: every project bucket costs the same", () => {
    // Green on the parent commit too (every bucket was 4 there): this says
    // only that no per-project read got amplified, and is deliberately NOT
    // tied to PER_GROUP_READS — that is the next test's job.
    expect(new Set(projectBuckets(m2)).size).toBe(1);
    expect(new Set(projectBuckets(m4)).size).toBe(1);
  });

  it("spends one read per project database less than it used to", () => {
    // Red on the parent commit at 4: this is the two `issues` reads (status
    // and deleted_at) becoming one.
    expect(projectBuckets(m2)[0]).toBe(PER_GROUP_READS);
    expect(projectBuckets(m4)[0]).toBe(PER_GROUP_READS);
  });
});

/**
 * One app, N projects each holding a prefix, `gaps` mirror rows deleted by
 * hand, one mirror sweep measured. Same one-app-at-a-time shape as `measure`.
 */
async function measureMirror(
  placement: PlacementMode,
  n: number,
  gaps: number,
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
          slug: `mir-${i}`,
          name: `Mirror ${i}`,
          ref_prefix: `M${i}`,
        }),
      });
      expect(res.status).toBe(201);
    }

    const system = t.ctx.router.system();
    // Punched into the system tier rather than through the API: every route
    // that writes a history row writes its mirror row too, so a gap is only
    // reachable by hand.
    const mirrored = await system.select().from(refPrefixes);
    const victims = mirrored.slice(0, gaps).map((row) => row.id);
    if (victims.length > 0) {
      await system.delete(refPrefixes).where(inArray(refPrefixes.id, victims));
    }

    const rows = await system.select().from(projects);
    const k = new Set(
      rows.map((row) => t.ctx.router.resolveProjectUrl(routeInfoOf(row))),
    ).size;

    let added = -1;
    const log = await countStatements(t, async () => {
      added = await syncRefPrefixMirror(t.ctx);
    });
    expect(added, "the fixture's gaps are what the sweep re-copied").toBe(gaps);
    return { log, k, systemUrl: t.ctx.router.systemHandle().url };
  } finally {
    await t.cleanup();
  }
}

describe("syncRefPrefixMirror, shared placement (k = 1)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measureMirror("shared", 4, 0);
    m8 = await measureMirror("shared", 8, 0);
  });

  it("regression watchdog: one statement at eight projects as at four", () => {
    // Not a claim this section can turn red: what holds the count at the lone
    // projects scan is the colocated skip, which belongs to the write side.
    // The obligation here is only that the empty-batch early return survives
    // the rewrite, so that a purely shared deployment opens no handle at all.
    expect(m4.k).toBe(1);
    expect(m8.log.total).toBe(m4.log.total);
    expect(m4.log.total).toBe(1);
  });
});

describe("syncRefPrefixMirror, dedicated-bucketed placement (k = 2)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measureMirror("dedicated-bucketed", 4, 2);
    m8 = await measureMirror("dedicated-bucketed", 8, 2);
  });

  it("sends the same statements for 8 projects as for 4, at two fixed gaps", () => {
    expect(m4.k).toBe(2);
    expect(m8.log.total).toBe(m4.log.total);
    expect(m8.log.total).toBe(SYNC_SYSTEM + 2);
    expect(m8.log.byUrl[m8.systemUrl]).toBe(SYNC_SYSTEM);
    expect(m4.log.byUrl[m4.systemUrl]).toBe(SYNC_SYSTEM);
    // One `ref_formats` read per database, whichever bucket the gaps fell in:
    // the insert that repairs them is a system-tier statement.
    expect(projectBuckets(m8)).toEqual([1, 1]);
    expect(projectBuckets(m4)).toEqual([1, 1]);
  });
});

describe("syncRefPrefixMirror, dedicated placement (k = N)", () => {
  let m2: Measurement;
  let m4: Measurement;

  beforeAll(async () => {
    m2 = await measureMirror("dedicated", 2, 2);
    m4 = await measureMirror("dedicated", 4, 2);
  });

  it("keeps the system tier's share flat in N", () => {
    // The whole-request equality is false by construction at k = N — one
    // `ref_formats` read per project database is the irreducible half — so
    // the system tier's share is what is asserted.
    expect(m2.k).toBe(2);
    expect(m4.k).toBe(4);
    expect(m2.log.byUrl[m2.systemUrl]).toBe(SYNC_SYSTEM);
    expect(m4.log.byUrl[m4.systemUrl]).toBe(SYNC_SYSTEM);
  });

  it("regression watchdog: every project bucket costs the same", () => {
    expect(new Set(projectBuckets(m2)).size).toBe(1);
    expect(new Set(projectBuckets(m4)).size).toBe(1);
  });
});

describe("what repairBlocks still refuses", () => {
  it("regression watchdog: syncs the trash flag for a card whose status will not resolve", async () => {
    // Green on the parent commit, where the status read and the deleted_at
    // read were separate queries. It guards the one thing the merge of those
    // two reads could lose: `cleared` and `deleted` must stay apart, because
    // a card whose status row cannot be resolved yields NO verdict while its
    // trash flag is still perfectly well defined.
    const t = await makeTestApp("shared");
    try {
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      for (const slug of ["orphan-a", "orphan-b"]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
      }
      const blocked = await createIssue(t, headers, "orphan-a", "blocked");
      const blocker = await createIssue(t, headers, "orphan-a", "blocker");
      const res = await t.app.request(
        `/api/projects/orphan-a/issues/${blocked}/blocked-by`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ ref: `#${blocker}` }),
        },
      );
      expect(res.status).toBe(200);

      const system = t.ctx.router.system();
      const rows = await system.select().from(projects);
      const a = rows.find((r) => r.slug === "orphan-a")?.id as number;
      const b = rows.find((r) => r.slug === "orphan-b")?.id as number;
      const db = await t.ctx.router.forProject(
        routeInfoOf(
          rows.find((r) => r.slug === "orphan-a") as (typeof rows)[0],
        ),
      );
      // A dangling status_id cannot be written — `issues.status_id` carries a
      // foreign key — so the unresolvable status is a real row belonging to
      // ANOTHER project. That only satisfies the key while both projects sit
      // in one database, which is why this fixture is shared placement.
      const foreign = await db
        .select({ id: statuses.id })
        .from(statuses)
        .where(eq(statuses.projectId, b));
      await db
        .update(issues)
        .set({ statusId: foreign[0]?.id as number, deletedAt: new Date() })
        .where(and(eq(issues.projectId, a), eq(issues.number, blocker)));

      await repairBlocks(t.ctx);
      const edges = await system.select().from(issueBlocks);
      expect(edges[0]?.blockerDeletedAt).not.toBeNull();
    } finally {
      await t.cleanup();
    }
  });

  it("regression watchdog: announces the moved edges in the order the edges were read", async () => {
    // Green on the parent commit, which updated and announced edge by edge in
    // one loop. It guards what batching introduces: two `UPDATE … RETURNING`
    // statements whose row order is not the read order, feeding a timeline
    // whose entries are ordered by when they land.
    const t = await makeTestApp("shared");
    try {
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug: "order", name: "order" }),
      });
      expect(created.status).toBe(201);

      const mk = (title: string) => createIssue(t, headers, "order", title);
      const blockedR = await mk("re-blocked");
      const blockerR = await mk("re-blocked's blocker");
      const declare = async (blocked: number, blocker: number) => {
        const res = await t.app.request(
          `/api/projects/order/issues/${blocked}/blocked-by`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ ref: `#${blocker}` }),
          },
        );
        expect(res.status).toBe(200);
      };
      await declare(blockedR, blockerR);

      const system = t.ctx.router.system();
      const rows = await system.select().from(projects);
      const project = rows.find((r) => r.slug === "order") as (typeof rows)[0];
      const db = await t.ctx.router.forProject(routeInfoOf(project));
      const statusNamed = async (name: string) => {
        const found = await db
          .select({ id: statuses.id })
          .from(statuses)
          .where(
            and(eq(statuses.projectId, project.id), eq(statuses.name, name)),
          );
        return found[0]?.id as number;
      };
      const done = await statusNamed("Done");
      const todo = await statusNamed("Todo");

      // The read order of a sequential scan is heap order, and an UPDATE moves
      // the row's new version to the end of the heap. Clearing edge R through
      // the live path first is therefore what puts R AHEAD of the edge
      // declared next — without it both orderings would agree and this test
      // would assert nothing.
      const patched = await t.app.request(
        `/api/projects/order/issues/${blockerR}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ status_id: done }),
        },
      );
      expect(patched.status).toBe(200);
      await db
        .update(issues)
        .set({ statusId: todo })
        .where(
          and(eq(issues.projectId, project.id), eq(issues.number, blockerR)),
        );

      const blockedC = await mk("cleared");
      const blockerC = await mk("cleared's blocker");
      await declare(blockedC, blockerC);
      await db
        .update(issues)
        .set({ statusId: done })
        .where(
          and(eq(issues.projectId, project.id), eq(issues.number, blockerC)),
        );

      const edges = await system.select().from(issueBlocks);
      expect(
        edges.map((e) => e.blockerNumber),
        "the heap order this test depends on",
      ).toEqual([blockerR, blockerC]);

      const before = await db.select({ id: issueEvents.id }).from(issueEvents);
      const high = Math.max(...before.map((r) => r.id));
      await repairBlocks(t.ctx);
      // Ordered by id rather than by timestamp: two inserts can share a
      // microsecond.
      const landed = await db
        .select({ type: issueEvents.type })
        .from(issueEvents)
        .where(gt(issueEvents.id, high))
        .orderBy(asc(issueEvents.id));
      expect(landed.map((r) => r.type)).toEqual([
        "block_reblocked",
        "block_cleared",
      ]);
    } finally {
      await t.cleanup();
    }
  });
});
