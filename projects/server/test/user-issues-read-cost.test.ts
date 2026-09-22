import { beforeAll, describe, expect, it } from "vitest";
import { accessibleProjectRows, routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type PlacementMode,
  type StatementLog,
} from "./helpers.ts";

/**
 * What `GET /api/users/{ref}/issues` costs against the number of projects
 * the caller can read.
 *
 * Three counting mechanisms now live in this repo and they answer different
 * questions. test/blocks-read-cost.test.ts counts JavaScript calls with
 * `vi.mock` — its claim is "one helper runs once per page".
 * test/metadata.test.ts wraps `session.prepareQuery` and counts the
 * statements on a single handle. This file counts the statements one request
 * sends to *every* database, which only the driver-level logger can
 * attribute per url; neither of the other two can reach across handles.
 *
 * The counting rules, the definition of k and what each tier can prove are
 * in the plan's acceptance section. The short version: `shared` (k == 1)
 * resolves every project row back to the system url, so `byUrl` holds one
 * key and only the whole-request equality is available — the strongest one.
 * `dedicated-bucketed` (k == 2) is the only tier where the whole request and
 * the per-database attribution are both visible. `dedicated` (k == N) makes
 * the whole-request equality false by construction, so this file asserts
 * neither it nor the system bucket there: `bundleIssues` asks the system
 * database once per group, and at k == N the group count is N.
 *
 * Every assertion is relative. Absolute counts move whenever a neighbouring
 * card changes an unrelated query, and they are recorded in the commit
 * message rather than here.
 */

type Measured = {
  k: number;
  projectCount: number;
  status: number;
  items: number;
  log: StatementLog;
  /** Statements the system database answered, by url. */
  system: number;
  /** Per-project bucket counts, sorted: urls differ between two apps. */
  buckets: number[];
};

async function measure(placement: PlacementMode, n: number): Promise<Measured> {
  const t = await makeTestApp(placement);
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    // A plain member, not the cookie account: `accessibleProjectRows` hands
    // an instance admin the whole projects table in one statement, which
    // decouples the count from the membership rows the fixture builds.
    const bob = await addUserWithToken(t.ctx, "uic-bob");
    const slugs = Array.from({ length: n }, (_, i) => `uic-p${i}`);
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
    // Identical content per project, and deliberately plain: a comment, a
    // status change, a move or a block would each make the count depend on
    // what the fixture wrote rather than on N — through the `fallbackIds`
    // branch in `unreadIssueState`, `blocksForIssues`'s early return, and
    // `ensureFrontiers`'s insert branch.
    for (const slug of slugs) {
      for (const title of ["first card", "second card"]) {
        const issue = await t.app.request(`/api/projects/${slug}/issues`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ title }),
        });
        expect(issue.status).toBe(201);
      }
    }

    const read = () =>
      t.app.request(`/api/users/${bob.user.login}/issues?limit=30`, {
        headers: bob.headers,
      });
    // Warm-up outside the window: `ensureFrontiers` spends select + insert +
    // reselect the first time a project is read and one select every time
    // after, and that difference would land in the count.
    const warmUp = await read();
    expect(warmUp.status).toBe(200);

    let status = 0;
    let items = 0;
    const log = await countStatements(t, async () => {
      const res = await read();
      status = res.status;
      items = ((await res.json()) as { items: unknown[] }).items.length;
    });

    const systemUrl = t.ctx.config.database.system;
    const rows = await accessibleProjectRows(t.ctx, bob.user);
    const urls = rows.map((row) =>
      t.ctx.router.resolveProjectUrl(routeInfoOf(row)),
    );
    // k is read back off the router rather than rebuilt from the url
    // template, and the system url is not removed: under `shared` the
    // project rows resolve to it and k is 1, which is that tier's claim.
    const k = new Set(urls).size;
    // Removing it is an attribution move, not part of k — under `shared` it
    // empties the set and no bucket assertion is available there.
    const projectUrls = new Set(urls);
    projectUrls.delete(systemUrl);

    return {
      k,
      projectCount: rows.length,
      status,
      items,
      log,
      system: log.byUrl[systemUrl] ?? 0,
      buckets: [...projectUrls]
        .map((url) => log.byUrl[url] ?? 0)
        .sort((a, b) => a - b),
    };
  } finally {
    await t.cleanup();
  }
}

describe("/api/users/{ref}/issues statement count (shared)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("shared", 4);
    big = await measure("shared", 8);
  }, 300_000);

  it("both fixtures answered a full page and k is 1", () => {
    for (const m of [small, big]) {
      expect(m.status).toBe(200);
      expect(m.k).toBe(1);
    }
    expect([small.projectCount, small.items]).toEqual([4, 8]);
    expect([big.projectCount, big.items]).toEqual([8, 16]);
  });

  it("costs the same at N=4 and N=8", () => {
    expect(big.log.total).toBe(small.log.total);
  });
});

describe("/api/users/{ref}/issues statement count (dedicated-bucketed)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("dedicated-bucketed", 4);
    big = await measure("dedicated-bucketed", 8);
  }, 300_000);

  it("both fixtures answered a full page and k is 2", () => {
    for (const m of [small, big]) {
      expect(m.status).toBe(200);
      expect(m.k).toBe(2);
      expect(m.buckets).toHaveLength(2);
    }
  });

  it("costs the same at N=4 and N=8", () => {
    expect(big.log.total).toBe(small.log.total);
  });

  it("each database and the system database answer at a fixed cost", () => {
    expect(big.buckets).toEqual(small.buckets);
    expect(big.system).toBe(small.system);
  });
});

describe("/api/users/{ref}/issues statement count (dedicated)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("dedicated", 4);
    big = await measure("dedicated", 8);
  }, 300_000);

  it("k is N", () => {
    expect(small.k).toBe(4);
    expect(big.k).toBe(8);
  });

  it("regression watchdog: every project database answers the same amount", () => {
    // Green before this card too — one database per project was already one
    // fan-out step per project — so this guards the slope rather than
    // claiming it. The whole-request equality is false by construction at
    // k == N and is not asserted; neither is the system bucket, which grows
    // with N here because `bundleIssues` asks the system database once per
    // group and the group count is N.
    for (const m of [small, big]) {
      expect(m.buckets).toEqual(m.buckets.map(() => m.buckets[0]));
    }
    expect(big.buckets[0]).toBe(small.buckets[0]);
  });
});
