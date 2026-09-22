import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { autolinks } from "../src/db/project-schema.ts";
import { projects } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import {
  countStatements,
  makeTestApp,
  type PlacementMode,
  type StatementLog,
  type TestApp,
} from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

/**
 * What a slug rename costs against the number of projects in the registry,
 * and what the shadow check still refuses once it stops opening them one at
 * a time.
 *
 * Of the three counting mechanisms in this repo — counting CALLS of a funnel
 * function (test/blocks-read-cost.test.ts), counting statements against ONE
 * database through `session.prepareQuery` (test/metadata.test.ts) and the
 * url-attributed `StatementLog` — this file uses the first and the third
 * together, because the fan-out count and the statement attribution each pin
 * down only half of the claim. The second one is unusable here: wrapping a
 * handle's `prepareQuery` cannot see the statements a transaction body sends,
 * and the rename writes `slug_history` inside one.
 *
 * The counting rules, the definition of k and what each tier can prove are in
 * the plan's acceptance section. Absolute counts are recorded in the commit
 * message rather than here: they move whenever a neighbouring card changes an
 * unrelated query, so every assertion below is relative.
 */

type Measurement = {
  log: StatementLog;
  /** Distinct databases the registry's project rows resolve to. */
  k: number;
  /** `forProject` calls a rename-free PATCH already makes on its own. */
  base: number;
  renameCalls: number;
  systemUrl: string;
};

/**
 * One app, one pair of PATCHes, both observations. Standing up a second app
 * to measure the spy apart from the statement log would double the peak
 * number of live PGlite instances, which is what the memory budget in
 * vitest.config.ts is about.
 */
async function measure(
  placement: PlacementMode,
  n: number,
): Promise<Measurement> {
  const t = await makeTestApp(placement);
  const spy = vi.spyOn(t.ctx.router, "forProject");
  try {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    for (let i = 0; i < n; i++) {
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug: `pr-${i}`, name: `Project ${i}` }),
      });
      expect(res.status).toBe(201);
    }
    // An autolink unrelated to every slug this fixture renames to: the check
    // has to scan a non-empty table to be measuring anything.
    const link = await t.app.request(
      "/api/projects/pr-1/references/autolinks",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          prefix: "zz#",
          url_template: "https://example.com/<num>",
        }),
      },
    );
    expect(link.status).toBe(201);

    // k is read back off the router the way the service routes, rather than
    // rebuilt from the url template — and through `routeInfoOf`, because a
    // hand-built `{ id, slug, database_url }` is the very mistake this card
    // is closing and a test must not demonstrate it. Under "shared" the
    // project rows resolve to the system url itself, so k is 1, not 0.
    const rows = await t.ctx.router.system().select().from(projects);
    const k = new Set(
      rows.map((row) => t.ctx.router.resolveProjectUrl(routeInfoOf(row))),
    ).size;

    const patch = (body: unknown) =>
      t.app.request("/api/projects/pr-0", {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });

    // A PATCH that renames nothing: it pays for everything the rename pays
    // for except the shadow check, so the difference is the fan-out. The
    // counter starts here, after the fixture's own handle opens.
    spy.mockClear();
    const warm = await patch({ name: "warm" });
    expect(warm.status).toBe(200);
    const base = spy.mock.calls.length;
    spy.mockClear();

    const log = await countStatements(t, async () => {
      const res = await patch({ slug: "pr-0x" });
      expect(res.status).toBe(200);
    });
    return {
      log,
      k,
      base,
      renameCalls: spy.mock.calls.length,
      systemUrl: t.ctx.config.database.system,
    };
  } finally {
    spy.mockRestore();
    await t.cleanup();
  }
}

/** Per-database counts, system's own excluded, comparable across apps. */
const projectBuckets = (m: Measurement): number[] =>
  Object.entries(m.log.byUrl)
    .filter(([url]) => url !== m.systemUrl)
    .map(([, count]) => count)
    .sort((a, b) => a - b);

describe("renaming a project, shared placement (k = 1)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("shared", 4);
    m8 = await measure("shared", 8);
  });

  it("sends the same statements for 8 projects as for 4", () => {
    expect(m8.log.total).toBe(m4.log.total);
    expect(
      m8.log.statements.filter((s) => s.sql.includes("autolinks")),
    ).toHaveLength(m8.k);
  });

  it("opens one database per group, not one per project", () => {
    expect(m4.renameCalls - m4.base).toBe(m4.k);
    expect(m8.renameCalls - m8.base).toBe(m8.k);
  });
});

describe("renaming a project, dedicated-bucketed placement (k = 2)", () => {
  let m4: Measurement;
  let m8: Measurement;

  beforeAll(async () => {
    m4 = await measure("dedicated-bucketed", 4);
    m8 = await measure("dedicated-bucketed", 8);
  });

  it("sends the same statements, and the same per bucket, for 8 as for 4", () => {
    expect(m8.log.total).toBe(m4.log.total);
    // Bucket urls carry a per-app run prefix, so the two apps share no keys;
    // what has to match is the multiset of counts.
    expect(projectBuckets(m8)).toEqual(projectBuckets(m4));
  });

  it("opens one database per group, not one per project", () => {
    expect(m4.renameCalls - m4.base).toBe(m4.k);
    expect(m8.renameCalls - m8.base).toBe(m8.k);
  });

  it("regression watchdog: the system database's share is already flat in N", () => {
    // Green on the parent commit too — this is not what the card buys. It
    // guards against a later change hanging a per-project registry query off
    // the rename path.
    expect(m8.log.byUrl[m8.systemUrl]).toBe(m4.log.byUrl[m4.systemUrl]);
  });
});

/** A fixture whose projects the caller can rename and corrupt at will. */
async function seed(slugs: string[]): Promise<{
  t: TestApp;
  headers: Record<string, string>;
  patch: (slug: string, body: unknown) => Promise<Response>;
}> {
  const t = await makeTestApp("shared");
  const cookie = await t.login();
  const headers = { "content-type": "application/json", cookie };
  for (const slug of slugs) {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: `Project ${slug}` }),
    });
    expect(res.status).toBe(201);
  }
  return {
    t,
    headers,
    patch: async (slug, body) =>
      await t.app.request(`/api/projects/${slug}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      }),
  };
}

async function addAutolink(
  t: TestApp,
  headers: Record<string, string>,
  slug: string,
  prefix: string,
): Promise<void> {
  const res = await t.app.request(
    `/api/projects/${slug}/references/autolinks`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        prefix,
        url_template: "https://example.com/<num>",
      }),
    },
  );
  expect(res.status).toBe(201);
}

describe("what the shadow check still refuses", () => {
  it("regression watchdog: an autolink left behind by a deleted project does not block a rename", async () => {
    // Green on the parent commit: this is the behaviour the rewrite may not
    // change, not a benefit of it.
    const { t, headers, patch } = await seed(["gone", "stay"]);
    try {
      await addAutolink(t, headers, "gone", "zz#");
      const deleted = await t.app.request("/api/projects/gone", {
        method: "DELETE",
        headers,
      });
      expect(deleted.status).toBe(204);
      // `deleteProject` clears issues, comments, events, attachments, labels,
      // insights settings, statuses and project_meta — autolinks survive it.
      const orphans = await t.ctx.router
        .system()
        .select({ id: autolinks.id })
        .from(autolinks);
      expect(orphans).toHaveLength(1);

      expect((await patch("stay", { slug: "zz" })).status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it("regression watchdog: a shadow in a database that answers is found even when another one will not", async () => {
    // Green on the parent commit: the rewrite may not lose a verdict just
    // because a sibling database is unreachable.
    const { t, headers, patch } = await seed(["ok-a", "ok-b", "dead"]);
    try {
      await addAutolink(t, headers, "ok-b", "zz#");
      const dead = await t.ctx.router
        .system()
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, "dead"));
      await t.ctx.router
        .system()
        .update(projects)
        .set({ databaseUrl: "postgres://u:p@127.0.0.1:1/nope" })
        .where(eq(projects.id, dead[0]?.id as number));

      expect((await patch("ok-a", { slug: "ok-a2" })).status).toBe(200);
      expect((await patch("ok-a2", { slug: "zz" })).status).toBe(422);
    } finally {
      await t.cleanup();
    }
  });

  it("regression watchdog: a project database that will not open is not a 500", async () => {
    // Green on the parent commit: an unopenable database has always been a
    // logged skip rather than a failed request.
    const { t, patch } = await seedWithUnopenableDatabase();
    try {
      expect((await patch("ok-a", { slug: "ok-a2" })).status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });

  it("documents the one grade of loosening", async () => {
    const { t, patch } = await seedWithUnopenableDatabase();
    try {
      // 422 on the parent commit, which skipped the broken database and kept
      // reading the healthy ones. `perDatabase` settles on the first
      // rejection and drops the surviving groups' results, and `forProject`
      // throws outside the callback's own try, so the only place left to
      // handle it is the outer catch — which can do nothing but fail open.
      //
      // Knowingly accepted: the cost is one autolink rule lying dormant, and
      // this is a guard rail rather than a security boundary. Strictness is
      // recoverable without giving up the statement count — group the rows by
      // `resolveProjectUrl(routeInfoOf(row))` in the caller and call
      // `perDatabase` once per group inside its own try — at the price of
      // writing back the grouping boilerplate `perDatabase` exists to remove,
      // and of losing the concurrency.
      expect((await patch("ok-a", { slug: "zz" })).status).toBe(200);
    } finally {
      await t.cleanup();
    }
  });
});

/** Three projects, a `zz#` autolink in a healthy one, and a broken pin. */
async function seedWithUnopenableDatabase(): Promise<{
  t: TestApp;
  patch: (slug: string, body: unknown) => Promise<Response>;
}> {
  const { t, headers, patch } = await seed(["ok-a", "ok-b", "broken"]);
  await addAutolink(t, headers, "ok-b", "zz#");
  const dir = testTmpDir("todou-autolink-shadow-");
  // A plain file where pglite wants a data directory: `openDb`'s mkdir fails
  // with EEXIST before any query is sent.
  writeFileSync(join(dir, "not-a-dir"), "");
  const broken = await t.ctx.router
    .system()
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, "broken"));
  await t.ctx.router
    .system()
    .update(projects)
    .set({ databaseUrl: `pglite://${join(dir, "not-a-dir")}` })
    .where(eq(projects.id, broken[0]?.id as number));
  return { t, patch };
}
