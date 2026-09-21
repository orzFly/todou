import { decodeMultiCursor } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accessibleProjectRows, routeInfoOf } from "../src/services/access.ts";
import {
  type VisibleProjects,
  visibleProjects,
} from "../src/services/cross-references.ts";
import {
  type ActivityEntry,
  fetchActivityRows,
} from "../src/services/timeline.ts";
import {
  addUserWithToken,
  countStatements,
  makeTestApp,
  PLACEMENTS,
  type PlacementMode,
  type TestApp,
} from "./helpers.ts";

/**
 * What `/activity` owes away from `placement=shared`: the ref spellings a
 * request may use each keep their own envelope slot once the fan-out is
 * folded into one statement per database, and the fold itself costs a number
 * of statements that no longer tracks the project count. The stream's own
 * judgements — trash audibility, `types=`, cross-reference redaction — are
 * decided once by test/activity-cross.test.ts; putting that 407-line fixture
 * through a third placement would re-decide the same cards at triple the cost
 * and tell us nothing about grouping.
 */

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps carry µs; keep writes apart so merge order is decidable. */
const settle = () => new Promise((r) => setTimeout(r, 5));

type ActivityItem = {
  type: string;
  id: number;
  project: string;
  issue_number: number;
};

const idOf = (i: ActivityItem) => `${i.type}:${i.project}:${i.id}`;

describe.each(PLACEMENTS)(
  "each ?projects= spelling holds its own slot (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let bob: Awaited<ReturnType<typeof addUserWithToken>>;
    const suffix = placement.replaceAll(/[^a-z]/g, "");
    /** Created under this slug, then renamed so the first one retires. */
    const born = `refs-born-${suffix}`;
    const renamed = `refs-now-${suffix}`;
    let projectId = 0;

    const admin = () => ({ "content-type": "application/json", cookie });

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      bob = await addUserWithToken(t.ctx, `refs-bob-${suffix}`);

      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ slug: born, name: born }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${born}/members/${bob.user.id}`,
        {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);

      const issue = await t.app.request(`/api/projects/${born}/issues`, {
        method: "POST",
        headers: admin(),
        body: JSON.stringify({ title: "a card worth watching" }),
      });
      expect(issue.status).toBe(201);
      const number = (await json(issue)).number as number;
      // Three comments plus the `opened` event make four activity rows, so a
      // limit of two cuts the stream in the middle and the resume below has
      // something left to lose.
      for (const body of ["one", "two", "three"]) {
        await settle();
        const res = await t.app.request(
          `/api/projects/${born}/issues/${number}/comments`,
          { method: "POST", headers: admin(), body: JSON.stringify({ body }) },
        );
        expect(res.status).toBe(201);
      }

      const rows = await accessibleProjectRows(t.ctx, bob.user);
      const row = rows.find((r) => r.slug === born);
      if (!row) throw new Error("bob cannot read the fixture project");
      projectId = row.id;

      const rename = await t.app.request(`/api/projects/${born}`, {
        method: "PATCH",
        headers: admin(),
        body: JSON.stringify({ slug: renamed }),
      });
      expect(rename.status).toBe(200);
    }, 120_000);

    afterAll(async () => {
      await t.cleanup();
    });

    const activity = async (qs: string) => {
      const res = await t.app.request(`/api/activity?${qs}`, {
        headers: bob.headers,
      });
      expect(res.status).toBe(200);
      return json(res);
    };

    /**
     * Walk the stream two rows at a time through the envelope it hands back,
     * which is the failure surface: a slot key the server does not recognise
     * falls through to `newestEnvelopePosition`, which either replays the
     * whole page or skips past it.
     */
    const drain = async (refs: string[]) => {
      const csv = refs.join(",");
      const seen: ActivityItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const after =
          cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`;
        const body = await activity(`projects=${csv}&limit=2${after}`);
        seen.push(...(body.items as ActivityItem[]));
        cursor = body.next_cursor;
        if (!body.has_more) break;
      }
      return { seen, cursor };
    };

    const expectNoReplayNoLoss = (seen: ActivityItem[], expected: number) => {
      expect(seen).toHaveLength(expected);
      expect(new Set(seen.map(idOf)).size).toBe(expected);
    };

    it("a numeric id keys the items and the envelope", async () => {
      const ref = String(projectId);
      const { seen, cursor } = await drain([ref]);
      expectNoReplayNoLoss(seen, 4);
      expect(new Set(seen.map((i) => i.project))).toEqual(new Set([ref]));
      const envelope = await decodeMultiCursor(cursor as string);
      expect(Object.keys(envelope ?? {})).toEqual([ref]);
    });

    it("a retired slug keys the items and the envelope", async () => {
      const { seen, cursor } = await drain([born]);
      expectNoReplayNoLoss(seen, 4);
      expect(new Set(seen.map((i) => i.project))).toEqual(new Set([born]));
      const envelope = await decodeMultiCursor(cursor as string);
      expect(Object.keys(envelope ?? {})).toEqual([born]);
    });

    it("two spellings of one project each hold a full copy", async () => {
      const ref = String(projectId);
      const { seen, cursor } = await drain([ref, born]);
      // Both spellings are watched independently, so every row is delivered
      // once per slot. Collapsing them would silently halve a watch that
      // resumes under only one of the two keys.
      expectNoReplayNoLoss(seen, 8);
      expect(seen.filter((i) => i.project === ref)).toHaveLength(4);
      expect(seen.filter((i) => i.project === born)).toHaveLength(4);
      const envelope = await decodeMultiCursor(cursor as string);
      expect(Object.keys(envelope ?? {}).sort()).toEqual([ref, born].sort());
    });
  },
);

describe("a split VALUES list keeps slot numbering global", () => {
  let t: TestApp;
  let visible: VisibleProjects;
  let admin: Awaited<ReturnType<typeof addUserWithToken>>;
  const SLUGS = ["chunk-a", "chunk-b", "chunk-c", "chunk-d"];
  const ids = new Map<string, number>();

  beforeAll(async () => {
    t = await makeTestApp("shared");
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    admin = await addUserWithToken(t.ctx, "chunk-admin", {
      instanceAdmin: true,
    });
    for (const slug of SLUGS) {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
      const issue = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `${slug} card` }),
      });
      expect(issue.status).toBe(201);
      const number = (await json(issue)).number as number;
      for (const body of ["one", "two", "three"]) {
        await settle();
        const res = await t.app.request(
          `/api/projects/${slug}/issues/${number}/comments`,
          { method: "POST", headers, body: JSON.stringify({ body }) },
        );
        expect(res.status).toBe(201);
      }
    }
    for (const row of await accessibleProjectRows(t.ctx, admin.user)) {
      ids.set(row.slug, row.id);
    }
    visible = await visibleProjects(t.ctx, admin.user);
  }, 120_000);

  afterAll(async () => {
    await t.cleanup();
  });

  it("hands every row back to the entry that asked for it", async () => {
    const db = t.ctx.router.system();
    const read = (entries: ActivityEntry[], chunk?: number) =>
      fetchActivityRows({
        db,
        entries,
        filters: {},
        visible,
        backward: false,
        fetchCount: 50,
        chunk,
      });

    const first = await read([
      { projectId: ids.get("chunk-a") as number, cursor: null },
    ]);
    const head = first[0];
    if (!head) throw new Error("chunk-a has no activity");
    const midStream = { t: head.ts, k: head.kind, i: head.row.id };

    // Entries 0 and 3 name the same project with different cursors and land
    // in different chunks, which is the pairing that renumbering corrupts.
    const entries: ActivityEntry[] = [
      { projectId: ids.get("chunk-a") as number, cursor: null },
      { projectId: ids.get("chunk-b") as number, cursor: null },
      { projectId: ids.get("chunk-c") as number, cursor: null },
      { projectId: ids.get("chunk-a") as number, cursor: midStream },
      { projectId: ids.get("chunk-d") as number, cursor: null },
    ];

    let rows: Awaited<ReturnType<typeof read>> = [];
    const log = await countStatements(t, async () => {
      rows = await read(entries, 2);
    });
    // Three chunks of at most two entries, two statements each.
    expect(log.total).toBe(6);

    for (const row of rows) {
      expect(row.slot).toBeGreaterThanOrEqual(0);
      expect(row.slot).toBeLessThan(entries.length);
      expect([row.slot, row.row.projectId]).toEqual([
        row.slot,
        entries[row.slot]?.projectId,
      ]);
    }
    // Every project holds one `opened` event plus three comments.
    expect(rows.filter((r) => r.slot === 0)).toHaveLength(4);
    for (const slot of [1, 2, 4]) {
      expect([slot, rows.filter((r) => r.slot === slot).length]).toEqual([
        slot,
        4,
      ]);
    }
    // The second window onto chunk-a starts after that project's first row,
    // so it is the same stream minus its head — not a copy of entry 0's.
    expect(rows.filter((r) => r.slot === 3)).toHaveLength(3);
    expect(
      rows.filter((r) => r.slot === 3).map((r) => `${r.kind}:${r.row.id}`),
    ).toEqual(
      rows
        .filter((r) => r.slot === 0)
        .slice(1)
        .map((r) => `${r.kind}:${r.row.id}`),
    );
  });
});

describe("routing arguments stay ProjectRouteInfo (regression watchdog)", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeTestApp("dedicated-bucketed");
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    for (const slug of ["route-a", "route-b"]) {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
    }
  }, 120_000);

  afterAll(async () => {
    await t.cleanup();
  });

  it("regression watchdog: every routed project carries database_url", async () => {
    // `ProjectRouteInfo.database_url` is optional, so a `ProjectRow` — whose
    // field is spelled `databaseUrl` — is structurally assignable and
    // compiles. At run time `resolveProjectUrl` then reads `undefined` and
    // sends a project pinned to its own database off to the template's.
    // Excess-property checking only fires on object literals, so typecheck
    // cannot see this; the shape of the actual argument is the only witness.
    const spy = vi.spyOn(t.ctx.router, "forProject");
    try {
      const cookie = await t.login();
      const res = await t.app.request("/api/activity", { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(spy.mock.calls.every(([arg]) => "database_url" in arg)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * One request's statement count against the number of projects it watches.
 * The counting rules, the definition of k and what each tier can prove live
 * in the plan's acceptance section; the short version:
 *
 * `shared` (k == 1) resolves every project row back to the system url, so
 * `byUrl` holds a single key and nothing can be attributed to a database.
 * Only the whole-request equality is available, and it is the strongest one.
 *
 * `dedicated-bucketed` (k == 2) is the only tier where the whole request and
 * the per-database attribution are both visible.
 *
 * `dedicated` (k == N) makes the whole-request equality false by
 * construction and it is not asserted — one database per project means the
 * total has to grow. Both cases there are regression watchdogs.
 */

type ActivityShape = "explicit" | "implicit" | "resume" | "tail";

const SHAPES: ActivityShape[] = ["explicit", "implicit", "resume", "tail"];

/**
 * Comments and issue_events: the two statements one database answers a
 * folded `/activity` read with, whatever the number of projects in it.
 */
const PER_DATABASE = 2;

type Measurement = {
  status: number;
  total: number;
  system: number;
  /** Per-project bucket counts, sorted: urls differ between two apps. */
  buckets: number[];
};

type Measured = {
  k: number;
  projectCount: number;
  shapes: Record<string, Measurement>;
};

async function measure(
  placement: PlacementMode,
  n: number,
  only?: ActivityShape[],
): Promise<Measured> {
  const t = await makeTestApp(placement);
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    // A plain member, not the cookie account: that one is an instance admin,
    // whose zero-query short circuit would hide the system side entirely.
    const bob = await addUserWithToken(t.ctx, "act-count-bob");
    const slugs = Array.from({ length: n }, (_, i) => `actc-p${i}`);
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

    // Two waves so a `last=1` envelope taken between them still resumes onto
    // a non-empty page: `getUserRefs` spends nothing on an empty page, so a
    // fixture whose resume comes back empty would move the total for a
    // reason that has nothing to do with N. The writer is the admin account
    // throughout — a second author, or an agent session, would add the owner
    // lookup to one fixture and not the other.
    const numbers = new Map<string, number>();
    for (const slug of slugs) {
      const issue = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: `${slug} card` }),
      });
      expect(issue.status).toBe(201);
      numbers.set(slug, (await json(issue)).number as number);
    }
    const commentOn = async (slug: string, body: string) => {
      await settle();
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${numbers.get(slug)}/comments`,
        { method: "POST", headers, body: JSON.stringify({ body }) },
      );
      expect(res.status).toBe(201);
    };
    for (const slug of slugs) await commentOn(slug, "first wave");

    const csv = slugs.join(",");
    const bootstrap = await t.app.request(
      `/api/activity?projects=${csv}&last=1&limit=1`,
      { headers: bob.headers },
    );
    expect(bootstrap.status).toBe(200);
    const envelope = (await json(bootstrap)).next_cursor as string;
    const positions = await decodeMultiCursor(envelope);
    // Every slot carries its own position, which is what makes the resume
    // exercise the per-entry cursor rather than one shared boundary.
    expect(new Set(Object.values(positions ?? {})).size).toBe(n);

    for (const slug of slugs) await commentOn(slug, "second wave");

    const requests: Record<ActivityShape, () => Promise<Response>> = {
      explicit: async () =>
        await t.app.request(`/api/activity?projects=${csv}`, {
          headers: bob.headers,
        }),
      implicit: async () =>
        await t.app.request("/api/activity", { headers: bob.headers }),
      resume: async () =>
        await t.app.request(
          `/api/activity?projects=${csv}&after=${encodeURIComponent(envelope)}`,
          { headers: bob.headers },
        ),
      tail: async () =>
        await t.app.request(`/api/activity?projects=${csv}&last=1&limit=1`, {
          headers: bob.headers,
        }),
    };

    const systemUrl = t.ctx.config.database.system;
    const rows = await accessibleProjectRows(t.ctx, bob.user);
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

    const shapes: Record<string, Measurement> = {};
    for (const name of only ?? SHAPES) {
      // One warm-up outside the window: the first read of a database opens
      // its handle and runs the project-tier migration, which would land in
      // the count. In-memory fixtures are already provisioned by
      // `createProject`, so this is defensive and unrelated to eviction —
      // `#evictIfNeeded` hands `pglite://memory` handles straight back.
      const warmUp = await requests[name]();
      expect(warmUp.status).toBeLessThan(400);
      let status = 0;
      let items = 0;
      const log = await countStatements(t, async () => {
        const res = await requests[name]();
        status = res.status;
        items = ((await json(res)).items as unknown[]).length;
      });
      // `tail` answers with an envelope and no items by design; the other
      // three must land on a non-empty page or the count is not measuring
      // the read this case is about.
      if (name !== "tail") expect([name, items > 0]).toEqual([name, true]);
      shapes[name] = {
        status,
        total: log.total,
        system: log.byUrl[systemUrl] ?? 0,
        buckets: [...projectUrls]
          .map((url) => log.byUrl[url] ?? 0)
          .sort((a, b) => a - b),
      };
    }

    return { k, projectCount: rows.length, shapes };
  } finally {
    await t.cleanup();
  }
}

function at(m: Measured, name: ActivityShape): Measurement {
  const found = m.shapes[name];
  if (!found) throw new Error(`shape ${name} was not measured`);
  return found;
}

describe("/activity statement count (shared)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("shared", 4);
    big = await measure("shared", 8);
  }, 300_000);

  it("every shape answered and k is 1", () => {
    for (const m of [small, big]) {
      for (const name of SHAPES) expect(at(m, name).status).toBe(200);
      expect(m.k).toBe(1);
    }
    expect(small.projectCount).toBe(4);
    expect(big.projectCount).toBe(8);
  });

  it.each(SHAPES)("%s costs the same at N=4 and N=8", (name) => {
    expect(at(big, name).total).toBe(at(small, name).total);
  });
});

describe("/activity statement count (dedicated-bucketed)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    small = await measure("dedicated-bucketed", 4);
    big = await measure("dedicated-bucketed", 8);
  }, 300_000);

  it("every shape answered and k is 2", () => {
    for (const m of [small, big]) {
      for (const name of SHAPES) expect(at(m, name).status).toBe(200);
      expect(m.k).toBe(2);
    }
  });

  it.each(SHAPES)("%s costs the same at N=4 and N=8", (name) => {
    expect(at(big, name).total).toBe(at(small, name).total);
  });

  it.each(SHAPES)("%s spends two statements per database", (name) => {
    for (const m of [small, big]) {
      expect([name, at(m, name).buckets]).toEqual([
        name,
        at(m, name).buckets.map(() => PER_DATABASE),
      ]);
    }
  });
});

describe("/activity statement count (dedicated)", () => {
  let small: Measured;
  let big: Measured;

  beforeAll(async () => {
    // One shape only: at k == N, N=8 means nine PGlite instances and every
    // extra shape is paid on all of them.
    small = await measure("dedicated", 4, ["explicit"]);
    big = await measure("dedicated", 8, ["explicit"]);
  }, 300_000);

  it("k is N", () => {
    expect(small.k).toBe(4);
    expect(big.k).toBe(8);
  });

  it("regression watchdog: the system bucket does not grow with N", () => {
    // Already N-independent before this card — batched authorization is what
    // flattened it — so this case guards that half rather than claiming it.
    expect(at(big, "explicit").system).toBe(at(small, "explicit").system);
  });

  it("regression watchdog: each extra project costs one database's worth", () => {
    // The whole-request equality is false by construction at k == N and is
    // not asserted. What is asserted is the slope: one comments statement
    // plus one issue_events statement per database, with nothing left over.
    expect(at(small, "explicit").buckets).toEqual(
      at(small, "explicit").buckets.map(() => PER_DATABASE),
    );
    expect(at(big, "explicit").buckets).toEqual(
      at(big, "explicit").buckets.map(() => PER_DATABASE),
    );
    const slope = (at(big, "explicit").total - at(small, "explicit").total) / 4;
    expect(slope).toBe(PER_DATABASE);
  });
});
