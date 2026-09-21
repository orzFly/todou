import type { ActivityCalendarResponse } from "@todou/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueEvents, issues, statuses } from "../src/db/project-schema.ts";
import { projects, users } from "../src/db/system-schema.ts";
import { accessibleProjectRows, routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type PlacementMode,
  type TestApp,
} from "./helpers.ts";

/**
 * Three counting mechanisms now live in this repo and they measure different
 * things. test/blocks-read-cost.test.ts counts *function calls* through
 * `vi.mock`, which needs one known funnel to hook. test/metadata.test.ts wraps
 * `session.prepareQuery` and counts statements against *one* database. What
 * this file has to show is that N projects did not become N round trips: there
 * is no single funnel to hook, and the system database has to be attributed
 * apart from the project databases. Only a driver-level statement tap that
 * carries the database url can do both, which is what `countStatements` is.
 */

const DAY = "2024-02-29";
const WINDOW = "from=2024-01-01&to=2025-01-01&tz=UTC";
/** Subjects born well before the window, so every day in it is recorded. */
const BIRTH = new Date("2020-01-01T00:00:00.000Z");

/**
 * moveHeads outside the snapshot, moveHeads re-read inside it, the aggregate
 * and the day selection: the four statements one database answers a folded
 * calendar read with, whatever the number of projects in it. `set transaction`
 * is transaction control and is counted apart from `total`. `legacyMoves` is
 * not in here either — a project created by this fixture has no legacy move
 * token, so that query short-circuits before it is sent, and it would go to
 * the system url rather than the group's.
 */
const PER_DATABASE = 4;

type Account = Awaited<ReturnType<typeof addUserWithToken>>;
type ProjectRows = Awaited<ReturnType<typeof accessibleProjectRows>>;

type Fixture = {
  t: TestApp;
  bob: Account;
  rows: ProjectRows;
};

async function seed(
  placement: PlacementMode,
  n: number,
  prefix: string,
  cardsPerProject = 1,
): Promise<Fixture> {
  const t = await makeTestApp(placement);
  const cookie = await t.login();
  const headers = { "content-type": "application/json", cookie };
  // A plain member, not the cookie account: that one is an instance admin,
  // whose short circuit would hide the authorization half entirely.
  const bob = await addUserWithToken(t.ctx, `${prefix}-bob`);
  const slugs = Array.from({ length: n }, (_, i) => `${prefix}-p${i}`);
  for (const slug of slugs) {
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    const member = await t.app.request(
      `/api/projects/${slug}/members/${bob.user.id}`,
      { method: "PUT", headers, body: JSON.stringify({ role: "writer" }) },
    );
    expect(member.status).toBe(204);
  }
  const system = t.ctx.router.system();
  await system
    .update(users)
    .set({ createdAt: BIRTH })
    .where(eq(users.id, bob.user.id));
  await system
    .update(projects)
    .set({ createdAt: BIRTH })
    .where(inArray(projects.slug, slugs));

  const rows = await accessibleProjectRows(t.ctx, bob.user);
  if (rows.length !== n) throw new Error("bob cannot read every fixture");
  for (const row of rows) {
    const db = await t.ctx.router.forProject(routeInfoOf(row));
    const [status] = await db
      .select()
      .from(statuses)
      .where(and(eq(statuses.projectId, row.id), eq(statuses.name, "Todo")));
    if (!status) throw new Error("Todo status fixture missing");
    for (let i = 0; i < cardsPerProject; i++) {
      // Written straight through the handle with a pinned timestamp: an
      // evidence row dated `now()` would drift across midnight.
      const at = new Date(`${DAY}T1${i}:00:00.000Z`);
      const [issue] = await db
        .insert(issues)
        .values({
          projectId: row.id,
          number: i + 1,
          title: `${row.slug} card ${i + 1}`,
          statusId: status.id,
          authorId: bob.user.id,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!issue) throw new Error("issue fixture missing");
      await db.insert(issueEvents).values({
        projectId: row.id,
        issueId: issue.id,
        actorId: bob.user.id,
        type: "opened",
        payload: {},
        createdAt: at,
      });
    }
  }
  return { t, bob, rows };
}

type Measured = {
  k: number;
  projectCount: number;
  total: number;
  /** How many databases the tap saw at all; `shared` must report one. */
  urlKeys: number;
  system: number;
  /** Per-project bucket counts, sorted: urls differ between two apps. */
  buckets: number[];
  /** Snapshot transactions per url over the same set that feeds k. */
  snapshotTx: number[];
  snapshotTxSystem: number;
};

async function measure(
  placement: PlacementMode,
  n: number,
  prefix: string,
): Promise<Measured> {
  const f = await seed(placement, n, prefix);
  try {
    const { t, bob, rows } = f;
    const path = `/api/users/${bob.user.id}/activity?${WINDOW}&day=${DAY}`;
    // One warm-up outside the window: the first read of a database opens its
    // handle and runs the project-tier migration, which would land in the
    // count. The fixture writes above have already opened every handle, so
    // this is defensive.
    const warmUp = await t.app.request(path, { headers: bob.headers });
    expect(warmUp.status).toBe(200);

    let status = 0;
    let selected = -1;
    const log = await countStatements(t, async () => {
      const res = await t.app.request(path, { headers: bob.headers });
      status = res.status;
      const body = (await res.json()) as ActivityCalendarResponse;
      selected = body.selection?.total ?? -1;
    });
    expect(status).toBe(200);
    // The measured request has to be answering with the whole fixture, or the
    // count belongs to some other read than the one under test.
    expect(selected).toBe(n);

    const systemUrl = t.ctx.config.database.system;
    const urls = rows.map((row) =>
      t.ctx.router.resolveProjectUrl(routeInfoOf(row)),
    );
    // k counts the distinct urls the project rows resolve to, read back off
    // the router rather than reconstructed from the template. The system url
    // is not removed here: under `shared` the rows resolve to it and k is 1,
    // which is exactly the claim that tier makes.
    const k = new Set(urls).size;
    // Removing it is an attribution move and not part of k: under `shared`
    // it empties the set and no bucket assertion is available there.
    const projectUrls = new Set(urls);
    projectUrls.delete(systemUrl);
    // PGlite delegates BEGIN/COMMIT to the client, so only `set transaction`
    // reaches the logger; node-postgres is the other way round. Every url in
    // this file is `pglite://memory`, so the first alternative is the one that
    // ever matches — the second is here so moving this to a real PostgreSQL
    // does not silently zero the assertion.
    const opens = log.statements.filter(
      (s) => s.txControl && /^\s*(set transaction|begin)\b/i.test(s.sql),
    );
    const opensAt = (url: string) => opens.filter((s) => s.url === url).length;

    return {
      k,
      projectCount: rows.length,
      total: log.total,
      urlKeys: Object.keys(log.byUrl).length,
      system: log.byUrl[systemUrl] ?? 0,
      buckets: [...projectUrls]
        .map((url) => log.byUrl[url] ?? 0)
        .sort((a, b) => a - b),
      snapshotTx: [...new Set(urls)].map(opensAt).sort((a, b) => a - b),
      snapshotTxSystem: opensAt(systemUrl),
    };
  } finally {
    await f.t.cleanup();
  }
}

describe("/api/users/{ref}/activity statement count", () => {
  it("shared: one snapshot answers the request and the cost does not track N", async () => {
    const small = await measure("shared", 4, "calc-sh4");
    const big = await measure("shared", 8, "calc-sh8");

    expect([small.k, big.k]).toEqual([1, 1]);
    expect([small.projectCount, big.projectCount]).toEqual([4, 8]);
    expect(big.total).toBe(small.total);
    expect(small.snapshotTx).toEqual([1]);
    expect(big.snapshotTx).toEqual([1]);
    // The system url and the project url are the same string here, so this
    // tier cannot attribute a statement to a database at all. Asserted
    // rather than left as a convention, so nobody adds a bucket expectation.
    expect([small.urlKeys, big.urlKeys]).toEqual([1, 1]);
  }, 120_000);

  it("dedicated-bucketed: four statements per database at N=4 and at N=8", async () => {
    const small = await measure("dedicated-bucketed", 4, "calc-bk4");
    const big = await measure("dedicated-bucketed", 8, "calc-bk8");

    expect([small.k, big.k]).toEqual([2, 2]);
    expect(big.total).toBe(small.total);
    expect(small.buckets).toEqual([PER_DATABASE, PER_DATABASE]);
    expect(big.buckets).toEqual([PER_DATABASE, PER_DATABASE]);
    expect(big.system).toBe(small.system);
    expect(small.snapshotTx).toEqual([1, 1]);
    expect(big.snapshotTx).toEqual([1, 1]);
    expect([small.snapshotTxSystem, big.snapshotTxSystem]).toEqual([0, 0]);
  }, 120_000);

  it("regression watchdog: dedicated spends one database's worth per project", async () => {
    // Green before and after this card: one project per database means the
    // whole-request equality is false by construction and is not asserted.
    // The system half was already flattened by batched authorization, and
    // the slope is what a per-project extra statement would break.
    // N=2 and N=4 rather than 4 and 8: at k == N every project is its own
    // PGlite instance and the fixture's memory is paid on all of them.
    const small = await measure("dedicated", 2, "calc-dd2");
    const big = await measure("dedicated", 4, "calc-dd4");

    expect([small.k, big.k]).toEqual([2, 4]);
    expect(big.system).toBe(small.system);
    const perProject = (big.total - small.total) / (4 - 2);
    expect(perProject).toBe(PER_DATABASE);
    expect(big.buckets).toEqual(big.buckets.map(() => PER_DATABASE));
    expect(small.buckets).toEqual(small.buckets.map(() => PER_DATABASE));
  }, 120_000);
});

describe("regression watchdog: the folded read still sees the whole group", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await seed("dedicated-bucketed", 4, "calx", 2);
  }, 120_000);

  afterAll(async () => {
    await f.t.cleanup();
  });

  it("agrees with the four per-project calendars", async () => {
    const read = async (path: string): Promise<ActivityCalendarResponse> => {
      const res = await f.t.app.request(path, { headers: f.bob.headers });
      expect(res.status).toBe(200);
      return (await res.json()) as ActivityCalendarResponse;
    };
    const dayCount = (body: ActivityCalendarResponse): number => {
      const day = body.days.find((entry) => entry.date === DAY);
      if (day?.state !== "recorded") throw new Error(`${DAY} is not recorded`);
      return day.count;
    };

    const user = await read(
      `/api/users/${f.bob.user.id}/activity?${WINDOW}&day=${DAY}`,
    );
    const perProject: ActivityCalendarResponse[] = [];
    for (const row of f.rows) {
      perProject.push(
        await read(
          `/api/projects/${row.slug}/insights/activity?${WINDOW}&day=${DAY}`,
        ),
      );
    }

    // An implementation that read only its group's first project passes every
    // statement-count case above and fails here.
    expect(dayCount(user)).toBe(
      perProject.reduce((sum, body) => sum + dayCount(body), 0),
    );
    expect(user.selection?.total).toBe(dayCount(user));
    expect(
      new Set(
        (user.selection?.items ?? []).map(
          (card) => `${card.project.slug}:${card.issue_id}`,
        ),
      ),
    ).toEqual(
      new Set(
        f.rows.flatMap((row, index) =>
          (perProject[index]?.selection?.items ?? []).map(
            (card) => `${row.slug}:${card.issue_id}`,
          ),
        ),
      ),
    );
  });
});
