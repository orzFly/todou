import { beforeAll, describe, expect, it } from "vitest";
import { accessibleProjectRows, routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  type PlacementMode,
} from "./helpers.ts";

/**
 * What each placement can and cannot prove, so no case here gets read as
 * more than it is.
 *
 * `shared` (k == 1) resolves every project back to the system url, so
 * `byUrl` has one key and nothing can be attributed to a database. Only
 * `/api/me/inbox?projects=` carries a whole-request equality here, because
 * it is the one changed path whose project side already groups by url; the
 * other four still fan out per project and an equality written for them
 * would be a lie.
 *
 * `dedicated-bucketed` (k == 2) is the only tier where "the whole request"
 * and "per database" are both visible. Every changed path asserts its
 * system bucket holds between N=4 and N=8 — that is this card's half. The
 * project buckets of the four paths whose fan-out belongs to a later card
 * are recorded in comments, not asserted, so a regression there lands on
 * the right card.
 *
 * `dedicated` (k == N) makes the whole-request equality false by
 * construction and it is not asserted. Only the system bucket and the
 * per-project constant are.
 *
 * Counts come from drizzle's logger, which sees statements inside
 * transactions. They are not comparable with a client-level tap on
 * PGlite's `query`/`exec`, which cannot see into `client.transaction` —
 * do not reconcile these numbers against any measured that way.
 *
 * Cases named "regression watchdog" were already equal before this card:
 * they exist so that a per-project statement added to an O(1) authorization
 * path goes red immediately.
 */

type EndpointName =
  | "inbox-explicit"
  | "inbox-implicit"
  | "activity-explicit"
  | "activity-implicit"
  | "user-activity"
  | "user-issues"
  | "mutes"
  | "reference-directory"
  | "user-projects"
  | "bulk-read";

/** Every changed path plus the watchdogs, in an order that keeps the
 * fixture's data shape steady: bulk read marks everything read, so it runs
 * last. */
const ALL_ENDPOINTS: EndpointName[] = [
  "inbox-explicit",
  "inbox-implicit",
  "activity-explicit",
  "activity-implicit",
  "user-activity",
  "user-issues",
  "mutes",
  "reference-directory",
  "user-projects",
  "bulk-read",
];

type Measurement = {
  status: number;
  total: number;
  system: number;
  /** Per-project bucket counts, sorted: urls differ between two apps. */
  buckets: number[];
  /** The same, minus the one project that holds cards. */
  emptyBuckets: number[];
};

type Measured = {
  k: number;
  projectCount: number;
  endpoints: Record<string, Measurement>;
};

async function measure(
  placement: PlacementMode,
  n: number,
  only?: EndpointName[],
): Promise<Measured> {
  const t = await makeTestApp(placement);
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    // A plain member, not the cookie account: that one is an instance
    // admin, whose zero-query short circuit would hide the whole axis.
    const bob = await addUserWithToken(t.ctx, "count-bob");
    const slugs = Array.from({ length: n }, (_, i) => `authb-p${i}`);
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

    // Seeds bob's read frontier: cards created after it are unread, which
    // is what keeps the inbox payload the same shape at every n.
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

    const csv = slugs.join(",");
    const ref = bob.user.login;
    const calendarQuery = "from=2026-01-01&to=2026-12-31&tz=UTC";
    const requests: Record<EndpointName, () => Response | Promise<Response>> = {
      "inbox-explicit": () =>
        t.app.request(`/api/me/inbox?projects=${csv}`, {
          headers: bob.headers,
        }),
      "inbox-implicit": () =>
        t.app.request("/api/me/inbox", { headers: bob.headers }),
      "activity-explicit": () =>
        t.app.request(`/api/activity?projects=${csv}`, {
          headers: bob.headers,
        }),
      "activity-implicit": () =>
        t.app.request("/api/activity", { headers: bob.headers }),
      "user-activity": () =>
        t.app.request(`/api/users/${ref}/activity?${calendarQuery}`, {
          headers: bob.headers,
        }),
      "user-issues": () =>
        t.app.request(`/api/users/${ref}/issues`, { headers: bob.headers }),
      mutes: () => t.app.request("/api/me/mutes", { headers: bob.headers }),
      "reference-directory": () =>
        t.app.request("/api/me/reference-directory", { headers: bob.headers }),
      "user-projects": () =>
        t.app.request(`/api/users/${ref}/projects`, { headers: bob.headers }),
      "bulk-read": () =>
        t.app.request("/api/me/read", {
          method: "PUT",
          headers: { ...bob.headers, "content-type": "application/json" },
          body: JSON.stringify({ projects: slugs }),
        }),
    };

    const systemUrl = t.ctx.config.database.system;
    const rows = await accessibleProjectRows(t.ctx, bob.user);
    const urlOf = new Map<string, string>();
    for (const row of rows) {
      urlOf.set(row.slug, t.ctx.router.resolveProjectUrl(routeInfoOf(row)));
    }
    // k counts the distinct urls the project rows resolve to, read back off
    // the router rather than reconstructed from the template. The system
    // url is not removed here: under `shared` the projects resolve to it
    // and k is 1, which is exactly the claim that tier makes.
    const k = new Set(urlOf.values()).size;
    const projectUrls = new Set(urlOf.values());
    // Removing it is an attribution move, not part of k: under `shared`
    // this empties the set and no bucket assertion is available.
    projectUrls.delete(systemUrl);
    const loadedUrl = urlOf.get(loadedSlug) as string;

    const endpoints: Record<string, Measurement> = {};
    for (const name of only ?? ALL_ENDPOINTS) {
      const warmUp = await requests[name]();
      expect(warmUp.status).toBeLessThan(400);
      let status = 0;
      const log = await countStatements(t, async () => {
        status = (await requests[name]()).status;
      });
      endpoints[name] = {
        status,
        total: log.total,
        system: log.byUrl[systemUrl] ?? 0,
        buckets: [...projectUrls]
          .map((url) => log.byUrl[url] ?? 0)
          .sort((a, b) => a - b),
        emptyBuckets: [...projectUrls]
          .filter((url) => url !== loadedUrl)
          .map((url) => log.byUrl[url] ?? 0)
          .sort((a, b) => a - b),
      };
    }

    return { k, projectCount: rows.length, endpoints };
  } finally {
    await t.cleanup();
  }
}

function at(m: Measured, name: EndpointName): Measurement {
  const found = m.endpoints[name];
  if (!found) throw new Error(`endpoint ${name} was not measured`);
  return found;
}

describe("cross-project authorization statement count (shared)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("shared", 4);
    big = await measure("shared", 8);
  }, 300_000);

  it("every endpoint answered", () => {
    for (const m of [small, big]) {
      for (const name of ALL_ENDPOINTS) {
        expect(at(m, name).status).toBeLessThan(400);
      }
    }
    expect(small.k).toBe(1);
    expect(big.k).toBe(1);
    expect(small.projectCount).toBe(4);
    expect(big.projectCount).toBe(8);
  });

  it("/api/me/inbox?projects= costs the same at N=4 and N=8", () => {
    expect(at(big, "inbox-explicit").total).toBe(
      at(small, "inbox-explicit").total,
    );
  });

  it("/api/me/inbox?projects= costs what the implicit branch costs", () => {
    // Two named-slug lookups against two membership queries: the explicit
    // branch resolves the refs and reads the roles, the implicit one reads
    // the memberships and then the rows.
    expect(at(big, "inbox-explicit").total).toBe(
      at(big, "inbox-implicit").total,
    );
  });

  it("regression watchdog: the O(1) entry points do not grow with N", () => {
    // Already N-independent before this card. The point of the case is
    // that anyone adding a per-project system query to listMutes,
    // referenceDirectory, listUserProjects or getInbox's implicit branch
    // goes red on the spot.
    for (const name of [
      "inbox-implicit",
      "mutes",
      "reference-directory",
      "user-projects",
    ] as const) {
      expect(at(big, name).total).toBe(at(small, name).total);
    }
  });
});

describe("cross-project authorization statement count (dedicated-bucketed)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("dedicated-bucketed", 4);
    big = await measure("dedicated-bucketed", 8);
  }, 300_000);

  it("every endpoint answered and k is 2", () => {
    for (const m of [small, big]) {
      for (const name of ALL_ENDPOINTS) {
        expect(at(m, name).status).toBeLessThan(400);
      }
      expect(m.k).toBe(2);
    }
  });

  it("the system bucket of every changed path holds at N=4 and N=8", () => {
    for (const name of [
      "inbox-explicit",
      "bulk-read",
      "activity-explicit",
      "activity-implicit",
      "user-activity",
    ] as const) {
      expect([name, at(big, name).system]).toEqual([
        name,
        at(small, name).system,
      ]);
    }
  });

  it("/api/me/inbox?projects= holds as a whole request and per bucket", () => {
    expect(at(big, "inbox-explicit").total).toBe(
      at(small, "inbox-explicit").total,
    );
    expect(at(big, "inbox-explicit").buckets).toEqual(
      at(small, "inbox-explicit").buckets,
    );
  });

  it("regression watchdog: the O(1) entry points do not grow with N", () => {
    // Already N-independent before this card; see the shared tier.
    for (const name of [
      "inbox-implicit",
      "mutes",
      "reference-directory",
      "user-projects",
    ] as const) {
      expect(at(big, name).total).toBe(at(small, name).total);
    }
    // listUserIssues authorizes with one accessibleProjectRows call; its
    // project side grows with N and belongs to a later card, so only the
    // system bucket is pinned here.
    expect(at(big, "user-issues").system).toBe(at(small, "user-issues").system);
  });

  it("records the project-side fan-out that other cards still owe", () => {
    // Attribution, not correctness: these buckets still double with N, and
    // naming which card owns each one is what keeps a future regression
    // from being blamed on authorization. Measured per bucket at N=4 → N=8:
    // bulk-read 4 → 8 (bulkMarkRead's own transaction per project),
    // /activity 4 → 8 both branches, the calendar 6 → 12. The equality
    // asserted below is only that the bucket count itself is stable.
    for (const name of [
      "bulk-read",
      "activity-explicit",
      "activity-implicit",
      "user-activity",
    ] as const) {
      expect(at(big, name).buckets.length).toBe(at(small, name).buckets.length);
    }
  });
});

describe("cross-project authorization statement count (dedicated)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    // One endpoint only: under `dedicated` N=8 means nine PGlite
    // instances, and every extra endpoint is paid on all of them.
    small = await measure("dedicated", 4, ["inbox-explicit"]);
    big = await measure("dedicated", 8, ["inbox-explicit"]);
  }, 300_000);

  it("k is N", () => {
    expect(small.k).toBe(4);
    expect(big.k).toBe(8);
  });

  it("the system bucket of /api/me/inbox?projects= holds at N=4 and N=8", () => {
    expect(at(big, "inbox-explicit").system).toBe(
      at(small, "inbox-explicit").system,
    );
  });

  it("each extra project costs one empty project's worth of statements", () => {
    // The whole-request equality is false by construction at k == N and is
    // not asserted. What is asserted is that the slope is exactly the
    // per-project read, with nothing left over for authorization: c is
    // read out of an empty bucket in this very run rather than written
    // down, so a change in the project-side read cost moves both sides.
    const c = at(big, "inbox-explicit").emptyBuckets[0] as number;
    expect(at(small, "inbox-explicit").emptyBuckets).toEqual(
      at(small, "inbox-explicit").emptyBuckets.map(() => c),
    );
    expect(at(big, "inbox-explicit").emptyBuckets).toEqual(
      at(big, "inbox-explicit").emptyBuckets.map(() => c),
    );
    const slope =
      (at(big, "inbox-explicit").total - at(small, "inbox-explicit").total) / 4;
    expect(slope).toBe(c);
  });
});
