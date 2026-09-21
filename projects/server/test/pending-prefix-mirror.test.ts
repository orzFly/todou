import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refFormats } from "../src/db/project-schema.ts";
import {
  pendingPrefixMirrors,
  projects,
  refPrefixes,
} from "../src/db/system-schema.ts";
import { type ProjectRow, routeInfoOf } from "../src/services/access.ts";
import { runHousekeepingTick } from "../src/services/housekeeping.ts";
import {
  drainPendingMirrors,
  markPendingMirror,
} from "../src/services/pending-mirror.ts";
import {
  mirrorPrefixGaps,
  syncRefPrefixMirror,
} from "../src/services/reference-directory.ts";
import { countStatements, makeTestApp, type TestApp } from "./helpers.ts";

const json = (cookie: string) => ({
  "content-type": "application/json",
  cookie,
});

async function projectRow(t: TestApp, slug: string): Promise<ProjectRow> {
  const rows = await t.ctx.router
    .system()
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const row = rows[0];
  if (!row) throw new Error(`no project ${slug}`);
  return row;
}

describe("markPendingMirror", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ slug: "pm-d1", name: "Pending dedicated" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("keeps one row per project and only moves the generation", async () => {
    const system = t.ctx.router.system();
    const project = await projectRow(t, "pm-d1");
    await system
      .delete(pendingPrefixMirrors)
      .where(eq(pendingPrefixMirrors.projectId, project.id));

    await markPendingMirror(t.ctx, project);
    const first = await system
      .select()
      .from(pendingPrefixMirrors)
      .where(eq(pendingPrefixMirrors.projectId, project.id));
    expect(first).toHaveLength(1);
    const before = first[0] as NonNullable<(typeof first)[0]>;
    expect(before.generation).toBe(1);

    await markPendingMirror(t.ctx, project);
    const second = await system
      .select()
      .from(pendingPrefixMirrors)
      .where(eq(pendingPrefixMirrors.projectId, project.id));
    expect(second).toHaveLength(1);
    const after = second[0] as NonNullable<(typeof second)[0]>;
    expect(after.generation).toBe(2);
    expect(after.attempts).toBe(before.attempts);
    expect(after.nextAttemptAt.getTime()).toBe(before.nextAttemptAt.getTime());
    expect(after.firstMarkedAt.getTime()).toBe(before.firstMarkedAt.getTime());
  });
});

describe("markPendingMirror on a colocated project (shared placement)", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ slug: "pm-s1", name: "Pending shared" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("writes nothing at all", async () => {
    const system = t.ctx.router.system();
    const project = await projectRow(t, "pm-s1");
    await markPendingMirror(t.ctx, project);
    expect(await system.select().from(pendingPrefixMirrors)).toHaveLength(0);
  });
});

/**
 * The two properties the drain path needs from the shared reconcile that it
 * cannot get from `syncRefPrefixMirror`'s own guards, because it does not go
 * through `syncRefPrefixMirror` at all.
 */
describe("mirrorPrefixGaps as the drain path uses it", () => {
  let t: TestApp;
  let cookie: string;
  let failing: string | null = null;

  beforeAll(async () => {
    t = await makeTestApp("dedicated", undefined, {
      onQuery: (sql, _params, url) => {
        if (failing === url && /from "ref_formats"/.test(sql)) {
          throw new Error("injected: project database unreachable");
        }
      },
    });
    cookie = await t.login();
    for (const n of [1, 2]) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: json(cookie),
        body: JSON.stringify({
          slug: `pmg-d${n}`,
          name: `Gaps ${n}`,
          ref_prefix: `G${n}`,
        }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    failing = null;
    await t.cleanup();
  });

  it("spends no statement at all on an empty project list", async () => {
    const log = await countStatements(t, async () => {
      expect(await mirrorPrefixGaps(t.ctx, [])).toEqual([]);
    });
    expect(log.total).toBe(0);
  });

  it("repairs the reachable databases before reporting the broken one", async () => {
    const system = t.ctx.router.system();
    const one = await projectRow(t, "pmg-d1");
    const two = await projectRow(t, "pmg-d2");
    await system.delete(refPrefixes);
    failing = t.ctx.router.resolveProjectUrl(routeInfoOf(one));

    await expect(syncRefPrefixMirror(t.ctx)).rejects.toThrow("injected");

    // The group that answered is repaired even though the other one threw.
    const after = await system.select().from(refPrefixes);
    expect(after.map((row) => row.projectId)).toEqual([two.id]);
    expect(after.map((row) => row.prefix)).toEqual(["G2"]);

    failing = null;
    expect(await syncRefPrefixMirror(t.ctx)).toBe(1);
  });
});

describe("drainPendingMirrors", () => {
  let t: TestApp;
  let cookie: string;

  const create = (n: number, prefix: string | null) =>
    t.app.request("/api/projects", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({
        slug: `pd-${n}`,
        name: `Drain ${n}`,
        ...(prefix === null ? {} : { ref_prefix: prefix }),
      }),
    });

  const marked = ["pd-1", "pd-2", "pd-3"];

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    cookie = await t.login();
    // Eight projects, three of them named. The pending set is stated
    // explicitly rather than "every project has a prefix": a fixture that
    // marks everything would make every statement count grow with N.
    for (let n = 1; n <= 8; n++) {
      expect((await create(n, n <= 3 ? `D${n}` : null)).status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function markOnly(slugs: string[], now?: Date): Promise<void> {
    const system = t.ctx.router.system();
    await system.delete(pendingPrefixMirrors);
    for (const slug of slugs) {
      await markPendingMirror(t.ctx, await projectRow(t, slug));
    }
    if (now) {
      await system
        .update(pendingPrefixMirrors)
        .set({ nextAttemptAt: now, attempts: 0 });
    }
  }

  it("claims only what is due and needs two clean passes to forget it", async () => {
    const system = t.ctx.router.system();
    const now = new Date();
    await markOnly(marked, now);

    const first = await drainPendingMirrors(t.ctx, now);
    expect(first.claimed).toBe(3);
    expect(first.confirmed).toBe(3);
    expect(first.deleted).toBe(0);
    expect(await system.select().from(pendingPrefixMirrors)).toHaveLength(3);

    // The backoff is real: nothing is due again at the same instant.
    expect((await drainPendingMirrors(t.ctx, now)).claimed).toBe(0);

    const later = new Date(now.getTime() + 10 * 60 * 1000);
    const second = await drainPendingMirrors(t.ctx, later);
    expect(second.claimed).toBe(3);
    expect(second.deleted).toBe(3);
    expect(await system.select().from(pendingPrefixMirrors)).toHaveLength(0);
  });

  // Last in this describe: it leaves pd-1 pointing at a database that is not
  // there, and the router caches handles by url.
  it("repairs the reachable projects and records the unreachable one", async () => {
    const system = t.ctx.router.system();
    const one = await projectRow(t, "pd-1");
    const two = await projectRow(t, "pd-2");
    await system
      .delete(refPrefixes)
      .where(inArray(refPrefixes.projectId, [one.id, two.id]));
    await system
      .update(projects)
      .set({ databaseUrl: "postgres://127.0.0.1:1/nope" })
      .where(eq(projects.id, one.id));

    const now = new Date();
    await markOnly(["pd-1", "pd-2"], now);
    const result = await drainPendingMirrors(t.ctx, now);

    expect(result.claimed).toBe(2);
    expect(result.failed).toBe(1);
    // The reachable group's gap is filled even though the other group threw.
    expect(result.repaired).toBe(1);
    const mirrored = await system
      .select()
      .from(refPrefixes)
      .where(inArray(refPrefixes.projectId, [one.id, two.id]));
    expect(mirrored.map((row) => row.projectId)).toEqual([two.id]);

    const broken = (
      await system
        .select()
        .from(pendingPrefixMirrors)
        .where(eq(pendingPrefixMirrors.projectId, one.id))
    )[0];
    if (!broken) throw new Error("expected pd-1 to still be marked");
    expect(broken.attempts).toBe(1);
    expect(broken.lastError).toBeTruthy();
    expect(broken.verifiedGeneration).toBe(0);

    expect((await drainPendingMirrors(t.ctx, now)).claimed).toBe(0);
    const later = new Date(now.getTime() + 10 * 60 * 1000);
    expect((await drainPendingMirrors(t.ctx, later)).claimed).toBeGreaterThan(
      0,
    );
  });
});

/**
 * A1 — the benefit this card buys, stated as an end-to-end property: a hole
 * punched between the two cross-database writes closes on the next hourly
 * tick instead of waiting for a restart. Red on the parent commit, where the
 * second half stops at 404.
 */
describe.each(["dedicated", "dedicated-bucketed"] as const)(
  "a cross-database mirror hole closes within the hour (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let breakMirror = false;
    let projectId = 0;

    beforeAll(async () => {
      t = await makeTestApp(placement, undefined, {
        onQuery: (sql) => {
          if (breakMirror && /insert into "ref_prefixes"/.test(sql)) {
            throw new Error("injected: mirror write lost");
          }
        },
      });
      cookie = await t.login();
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: json(cookie),
        body: JSON.stringify({ slug: "a1", name: "Hole" }),
      });
      expect(res.status).toBe(201);
      projectId = ((await res.json()) as { id: number }).id;
      const issue = await t.app.request("/api/projects/a1/issues", {
        method: "POST",
        headers: json(cookie),
        body: JSON.stringify({ title: "first" }),
      });
      expect(issue.status).toBe(201);
    });

    afterAll(async () => {
      breakMirror = false;
      await t.cleanup();
    });

    const resolve = () =>
      t.app.request("/api/me/refs/resolve?ref=NEW-1", { headers: { cookie } });

    it("repairs the hole on the next tick and stays idempotent", async () => {
      const system = t.ctx.router.system();
      breakMirror = true;
      const put = await t.app.request("/api/projects/a1/references/format", {
        method: "PUT",
        headers: json(cookie),
        body: JSON.stringify({ prefix: "NEW" }),
      });
      breakMirror = false;
      expect(put.status).toBeGreaterThanOrEqual(500);

      // The authoritative row landed, its mirror did not, and the mark names
      // the project whose mirror is now behind.
      const own = await (
        await t.ctx.router.forProject(routeInfoOf(await projectRow(t, "a1")))
      )
        .select()
        .from(refFormats)
        .where(eq(refFormats.projectId, projectId));
      expect(own.map((row) => row.prefix)).toEqual(["NEW"]);
      expect(
        await system
          .select()
          .from(refPrefixes)
          .where(eq(refPrefixes.projectId, projectId)),
      ).toHaveLength(0);
      expect(
        await system
          .select()
          .from(pendingPrefixMirrors)
          .where(eq(pendingPrefixMirrors.projectId, projectId)),
      ).toHaveLength(1);
      expect((await resolve()).status).toBe(404);

      await runHousekeepingTick(t.ctx);

      expect(
        await system
          .select()
          .from(refPrefixes)
          .where(eq(refPrefixes.projectId, projectId)),
      ).toHaveLength(1);
      const good = await resolve();
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({
        names: { project_ref: String(projectId), number: 1 },
        at: { slug: "a1", number: 1 },
      });

      await runHousekeepingTick(t.ctx);
      expect(
        await system
          .select()
          .from(refPrefixes)
          .where(eq(refPrefixes.projectId, projectId)),
      ).toHaveLength(1);
    });
  },
);

/**
 * A2–A5 and A9: the protocol's own guarantees. Every name says which kind of
 * assertion it is, because only A9 is a benefit — the rest guard code this
 * card introduced, and would be red on the parent commit merely because the
 * table does not exist there.
 */
describe.each(["dedicated", "dedicated-bucketed"] as const)(
  "the pending-mirror protocol (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let inject: RegExp | null = null;
    let beforeHistory: (() => Promise<void>) | null = null;
    let beforeUnmark: (() => Promise<void>) | null = null;

    beforeAll(async () => {
      t = await makeTestApp(placement, undefined, {
        onQuery: (sql) => {
          if (inject?.test(sql)) throw new Error("injected write failure");
        },
        beforeMirrorStep: async (step) => {
          if (step === "history") await beforeHistory?.();
          else await beforeUnmark?.();
        },
      });
      cookie = await t.login();
    });

    afterAll(async () => {
      inject = null;
      beforeHistory = null;
      beforeUnmark = null;
      await t.cleanup();
    });

    const mk = async (slug: string): Promise<ProjectRow> => {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: json(cookie),
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      return projectRow(t, slug);
    };

    const put = (slug: string, prefix: string) =>
      t.app.request(`/api/projects/${slug}/references/format`, {
        method: "PUT",
        headers: json(cookie),
        body: JSON.stringify({ prefix }),
      });

    const pendingOf = async (id: number) =>
      (
        await t.ctx.router
          .system()
          .select()
          .from(pendingPrefixMirrors)
          .where(eq(pendingPrefixMirrors.projectId, id))
      )[0];

    const mirrorsOf = async (id: number) =>
      t.ctx.router
        .system()
        .select()
        .from(refPrefixes)
        .where(eq(refPrefixes.projectId, id));

    /** Make this project's mark due at `now`, whatever the backoff said. */
    const dueAt = (id: number, now: Date) =>
      t.ctx.router
        .system()
        .update(pendingPrefixMirrors)
        .set({ nextAttemptAt: now })
        .where(eq(pendingPrefixMirrors.projectId, id));

    it("guard (A2): the mark lands before the authoritative write", async () => {
      const project = await mk("a2");
      inject = /insert into "ref_formats"/;
      const res = await put("a2", "AB");
      inject = null;
      expect(res.status).toBeGreaterThanOrEqual(500);

      const own = await (await t.ctx.router.forProject(routeInfoOf(project)))
        .select()
        .from(refFormats)
        .where(eq(refFormats.projectId, project.id));
      expect(own).toHaveLength(0);
      // An over-report: nothing is broken, and the mark still has to be
      // cleared by two clean passes rather than by the writer.
      expect(await pendingOf(project.id)).toBeDefined();

      const now = new Date();
      await dueAt(project.id, now);
      expect((await drainPendingMirrors(t.ctx, now)).deleted).toBe(0);
      const later = new Date(now.getTime() + 6 * 60 * 1000);
      expect((await drainPendingMirrors(t.ctx, later)).deleted).toBe(1);
      expect(await pendingOf(project.id)).toBeUndefined();
      expect(await mirrorsOf(project.id)).toHaveLength(0);
    });

    // A row present is not a hole; this case exists so that "let the writer
    // delete its own mark" turns red. Writer V marks, writer W marks, and
    // the row carries only W's generation — W deleting on its own success
    // would erase V's still-open window along with it.
    it("guard (A3): a clean PUT leaves a mark until two passes clear it", async () => {
      const project = await mk("a3");
      expect((await put("a3", "AC")).status).toBe(200);
      const marked = await pendingOf(project.id);
      expect(marked).toBeDefined();
      expect(await mirrorsOf(project.id)).toHaveLength(1);

      const now = new Date();
      await dueAt(project.id, now);
      expect((await drainPendingMirrors(t.ctx, now)).confirmed).toBe(1);
      const confirmed = await pendingOf(project.id);
      if (!confirmed) throw new Error("expected the mark to survive one pass");
      expect(confirmed.verifiedGeneration).toBe(confirmed.generation);

      const later = new Date(now.getTime() + 6 * 60 * 1000);
      expect((await drainPendingMirrors(t.ctx, later)).deleted).toBe(1);
      expect(await pendingOf(project.id)).toBeUndefined();
      expect(await mirrorsOf(project.id)).toHaveLength(1);
    });

    it("guard (A4): a failed mark leaves nothing behind at all", async () => {
      const project = await mk("a4");
      inject = /insert into "pending_prefix_mirrors"/;
      const res = await put("a4", "AD");
      inject = null;
      expect(res.status).toBeGreaterThanOrEqual(500);

      const own = await (await t.ctx.router.forProject(routeInfoOf(project)))
        .select()
        .from(refFormats)
        .where(eq(refFormats.projectId, project.id));
      expect(own).toHaveLength(0);
      expect(await pendingOf(project.id)).toBeUndefined();
      expect(await mirrorsOf(project.id)).toHaveLength(0);
    });

    it("guard (A5): a mark raised mid-pass survives the delete", async () => {
      const project = await mk("a5");
      expect((await put("a5", "AE")).status).toBe(200);
      const now = new Date();
      await dueAt(project.id, now);
      await drainPendingMirrors(t.ctx, now);

      const later = new Date(now.getTime() + 6 * 60 * 1000);
      beforeUnmark = async () => {
        await markPendingMirror(t.ctx, project);
      };
      const result = await drainPendingMirrors(t.ctx, later);
      beforeUnmark = null;

      expect(result.deleted).toBe(0);
      const survivor = await pendingOf(project.id);
      if (!survivor) throw new Error("the generation guard did not hold");
      // Not a failure, so the backoff is cleared rather than advanced: the
      // busiest projects must not climb to the ceiling by succeeding.
      expect(survivor.attempts).toBe(0);
      expect(survivor.nextAttemptAt.getTime()).toBe(later.getTime());
      expect((await drainPendingMirrors(t.ctx, later)).claimed).toBe(1);
    });

    // A9 — the second benefit assertion. One clean pass is not enough: the
    // mark commits before the write it guards, so a pass can read a history
    // that does not yet contain the row it is looking for.
    it("benefit (A9): a hole opened after a clean pass is still repaired", async () => {
      const project = await mk("a9");
      const issue = await t.app.request("/api/projects/a9/issues", {
        method: "POST",
        headers: json(cookie),
        body: JSON.stringify({ title: "first" }),
      });
      expect(issue.status).toBe(201);

      const t0 = new Date(Date.now() + 1000);
      beforeHistory = async () => {
        // The mark has committed; the history row has not been written yet.
        await drainPendingMirrors(t.ctx, t0);
      };
      inject = /insert into "ref_prefixes"/;
      const res = await put("a9", "AI");
      inject = null;
      beforeHistory = null;
      expect(res.status).toBeGreaterThanOrEqual(500);

      const survivor = await pendingOf(project.id);
      if (!survivor) throw new Error("the first pass deleted the mark");
      expect(survivor.verifiedGeneration).toBe(survivor.generation);
      expect(await mirrorsOf(project.id)).toHaveLength(0);
      const before = await t.app.request("/api/me/refs/resolve?ref=AI-1", {
        headers: { cookie },
      });
      expect(before.status).toBe(404);

      const result = await drainPendingMirrors(
        t.ctx,
        new Date(t0.getTime() + 6 * 60 * 1000),
      );
      expect(result.repaired).toBe(1);
      expect(result.deleted).toBe(1);
      expect(await mirrorsOf(project.id)).toHaveLength(1);
      const after = await t.app.request("/api/me/refs/resolve?ref=AI-1", {
        headers: { cookie },
      });
      expect(after.status).toBe(200);
      expect(await after.json()).toEqual({
        names: { project_ref: String(project.id), number: 1 },
        at: { slug: "a9", number: 1 },
      });
    });
  },
);

/**
 * One group's reconcile read: `select prefix, effective_from from ref_formats
 * where project_id in (…)`. The per-bucket assertions below are stated
 * against this constant so that a regression to one read per project shows up
 * as arithmetic rather than as a changed magic number.
 */
const MIRROR_GROUP_READS = 1;

type Counting = {
  t: TestApp;
  cookie: string;
  /** Create projects `from…to`, none of them prefixed. */
  create: (from: number, to: number) => Promise<void>;
  /** Give this project a prefix — a fixture step, not a counted one. */
  prefix: (slug: string) => Promise<void>;
  /** Exactly these projects marked, due at `now`, none of them confirmed. */
  markOnly: (slugs: string[], now: Date) => Promise<void>;
};

function countingFixture(
  placement: "shared" | "dedicated" | "dedicated-bucketed",
): Counting {
  const state = {} as Counting;
  beforeAll(async () => {
    state.t = await makeTestApp(placement);
    state.cookie = await state.t.login();
  });
  afterAll(async () => {
    await state.t.cleanup();
  });
  state.create = async (from, to) => {
    for (let n = from; n <= to; n++) {
      const res = await state.t.app.request("/api/projects", {
        method: "POST",
        headers: json(state.cookie),
        body: JSON.stringify({ slug: `cnt-${n}`, name: `Counted ${n}` }),
      });
      expect(res.status).toBe(201);
    }
  };
  state.prefix = async (slug) => {
    const res = await state.t.app.request(
      `/api/projects/${slug}/references/format`,
      {
        method: "PUT",
        headers: json(state.cookie),
        body: JSON.stringify({ prefix: `C${slug.split("-")[1]}` }),
      },
    );
    expect(res.status).toBe(200);
  };
  state.markOnly = async (slugs, now) => {
    const system = state.t.ctx.router.system();
    await system.delete(pendingPrefixMirrors);
    for (const slug of slugs) {
      await markPendingMirror(state.t.ctx, await projectRow(state.t, slug));
    }
    await system
      .update(pendingPrefixMirrors)
      .set({ nextAttemptAt: now, attempts: 0, verifiedGeneration: 0 });
  };
  return state;
}

/** Statements that did not go to the system database. */
function projectBuckets(
  t: TestApp,
  byUrl: Record<string, number>,
): Record<string, number> {
  const system = t.ctx.router.systemHandle().url;
  return Object.fromEntries(
    Object.entries(byUrl).filter(([url]) => url !== system),
  );
}

/** Two projects the router puts in the same bucket, by reading it back. */
async function sameBucket(t: TestApp, slugs: string[]): Promise<string[]> {
  const byUrl = new Map<string, string[]>();
  for (const slug of slugs) {
    const url = t.ctx.router.resolveProjectUrl(
      routeInfoOf(await projectRow(t, slug)),
    );
    byUrl.set(url, [...(byUrl.get(url) ?? []), slug]);
  }
  const pair = [...byUrl.values()].find((list) => list.length >= 2);
  if (!pair) throw new Error("no two projects share a bucket");
  return pair.slice(0, 2);
}

/**
 * A6 — cost registration, NOT a benefit. What turns from red to green here is
 * that the hourly tick started touching project databases at all: on the
 * parent commit the project buckets are empty, because nothing in the tick
 * ever reached a project database. It is here so that the cost is stated once
 * and cannot grow quietly.
 */
describe("the hourly tick's cost, per bucket (dedicated-bucketed placement)", () => {
  const f = countingFixture("dedicated-bucketed");
  let marked: string[] = [];

  it("charges one read per bucket, whatever N is", async () => {
    await f.create(1, 4);
    marked = await sameBucket(
      f.t,
      [1, 2, 3, 4].map((n) => `cnt-${n}`),
    );
    for (const slug of marked) await f.prefix(slug);

    await f.markOnly(marked, new Date());
    const four = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });

    await f.create(5, 8);
    await f.markOnly(marked, new Date());
    const eight = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });

    // Both marked projects live in one database, so one read answers for
    // both. Break the batching into one read per project and this is 2.
    const bucketsOfFour = projectBuckets(f.t, four.byUrl);
    expect(Object.values(bucketsOfFour)).toEqual([MIRROR_GROUP_READS]);
    expect(Object.values(projectBuckets(f.t, eight.byUrl))).toEqual([
      MIRROR_GROUP_READS,
    ]);

    const systemUrl = f.t.ctx.router.systemHandle().url;
    expect(eight.byUrl[systemUrl]).toBe(four.byUrl[systemUrl]);
  });

  it("costs one extra system statement and no project statement when nothing is marked", async () => {
    await f.t.ctx.router.system().delete(pendingPrefixMirrors);
    const four = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });
    expect(projectBuckets(f.t, four.byUrl)).toEqual({});
    // The claim, and nothing else: an empty table stops the drain at one
    // statement.
    const claims = four.statements.filter((s) =>
      /update "pending_prefix_mirrors"/.test(s.sql),
    );
    expect(claims).toHaveLength(1);
  });
});

/**
 * The k ≡ N placement cannot assert a whole-tick equality — the fan-out is N
 * by construction — so it asserts attribution instead: which buckets appear,
 * and how much each one is charged.
 */
describe("the hourly tick's attribution (dedicated placement)", () => {
  const f = countingFixture("dedicated");
  const marked = ["cnt-1", "cnt-2"];

  it("charges only the marked projects, one read each", async () => {
    await f.create(1, 4);
    for (const slug of marked) await f.prefix(slug);

    await f.markOnly(marked, new Date());
    const four = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });

    await f.create(5, 8);
    await f.markOnly(marked, new Date());
    const eight = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });

    const systemUrl = f.t.ctx.router.systemHandle().url;
    expect(eight.byUrl[systemUrl]).toBe(four.byUrl[systemUrl]);

    const wanted = new Set<string>();
    for (const slug of marked) {
      wanted.add(
        f.t.ctx.router.resolveProjectUrl(
          routeInfoOf(await projectRow(f.t, slug)),
        ),
      );
    }
    for (const log of [four, eight]) {
      const buckets = projectBuckets(f.t, log.byUrl);
      expect(new Set(Object.keys(buckets))).toEqual(wanted);
      expect(Object.values(buckets)).toEqual(
        Object.keys(buckets).map(() => MIRROR_GROUP_READS),
      );
    }
  });
});

/**
 * Watchdogs for the colocated placement. Both are green on the parent commit
 * as well — they guard other cards' work, not this one's, and go red only if
 * somebody reopens the sweep for colocated projects or splits the create
 * transaction back apart.
 */
describe("watchdog: a colocated deployment gains nothing and pays nothing", () => {
  const f = countingFixture("shared");

  it("watchdog: the hourly tick stays N-independent", async () => {
    await f.create(1, 4);
    await f.prefix("cnt-1");
    const four = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });
    await f.create(5, 8);
    const eight = await countStatements(f.t, async () => {
      await runHousekeepingTick(f.t.ctx);
    });
    expect(eight.total).toBe(four.total);
    // Per-bucket attribution is meaningless here: every project's url IS the
    // system url, which is why this placement gets no A6.
    expect(Object.keys(eight.byUrl)).toEqual([
      f.t.ctx.router.systemHandle().url,
    ]);
  });

  it("watchdog: colocated writes stay one transaction, so nothing is marked", async () => {
    expect(
      await f.t.ctx.router.system().select().from(pendingPrefixMirrors),
    ).toHaveLength(0);
  });
});

describe("watchdog: a colocated mirror write cannot half-land", () => {
  let t: TestApp;
  let cookie: string;
  let breakMirror = false;

  beforeAll(async () => {
    t = await makeTestApp("shared", undefined, {
      onQuery: (sql) => {
        if (breakMirror && /insert into "ref_prefixes"/.test(sql)) {
          throw new Error("injected: mirror write lost");
        }
      },
    });
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: json(cookie),
      body: JSON.stringify({ slug: "a8", name: "Colocated" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    breakMirror = false;
    await t.cleanup();
  });

  it("watchdog: rolls the history row back with it, and marks nothing", async () => {
    const project = await projectRow(t, "a8");
    breakMirror = true;
    const res = await t.app.request("/api/projects/a8/references/format", {
      method: "PUT",
      headers: json(cookie),
      body: JSON.stringify({ prefix: "A8" }),
    });
    breakMirror = false;
    expect(res.status).toBeGreaterThanOrEqual(500);

    const db = await t.ctx.router.forProject(routeInfoOf(project));
    expect(
      await db
        .select()
        .from(refFormats)
        .where(eq(refFormats.projectId, project.id)),
    ).toHaveLength(0);
    expect(
      await t.ctx.router.system().select().from(pendingPrefixMirrors),
    ).toHaveLength(0);
  });
});

/**
 * Watchdog on the request side: the format PUT is a single-slug route with no
 * fan-out, so its cost was already independent of N and still is. The
 * falsifiable half is the second assertion — a mark placed inside a loop
 * would send two.
 */
describe("watchdog: the format PUT stays N-independent (dedicated placement)", () => {
  const f = countingFixture("dedicated");

  it("watchdog: sends the same statements at four projects as at eight", async () => {
    await f.create(1, 4);
    const four = await countStatements(f.t, async () => {
      await f.prefix("cnt-1");
    });
    await f.create(5, 8);
    const eight = await countStatements(f.t, async () => {
      await f.prefix("cnt-2");
    });
    expect(eight.total).toBe(four.total);

    const marks = eight.statements.filter((s) =>
      /insert into "pending_prefix_mirrors"/.test(s.sql),
    );
    expect(marks).toHaveLength(1);
  });
});
