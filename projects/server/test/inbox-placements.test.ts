import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessibleProjectRows } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps carry µs; keep writes apart so recency order is decidable. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/**
 * The grouping layer the inbox grew in T-278, which only shows up away from
 * `placement=shared`: several groups running concurrently, and one group
 * carrying several projects so `project_id in (…)` really holds more than one
 * id. The judgement rules are checked once, on `shared`, by
 * test/inbox.test.ts — putting that 840-line shared fixture through three
 * placements would re-decide the same cards at triple the cost and tell us
 * nothing about grouping.
 */
type Fixture = {
  t: TestApp;
  /** Reader being judged; every card below is written by someone else. */
  bob: Awaited<ReturnType<typeof addUserWithToken>>;
  /** Project id per slug, as the system database assigned them. */
  ids: Map<string, number>;
};

async function setUp(
  placement: "dedicated" | "dedicated-bucketed",
  slugs: string[],
  maxOpen?: number,
): Promise<Fixture> {
  const t = await makeTestApp(placement, maxOpen ? { maxOpen } : undefined);
  const cookie = await t.login();
  const headers = { "content-type": "application/json", cookie };
  const bob = await addUserWithToken(t.ctx, "grouping-bob");

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

  // Mints bob's frontier in every project before any card exists; without it
  // the cards below are dated before his epoch and arrive already read.
  const empty = await t.app.request("/api/me/inbox", { headers: bob.headers });
  expect(empty.status).toBe(200);
  expect((await json(empty)).items).toEqual([]);
  await settle();

  const rows = await accessibleProjectRows(t.ctx, bob.user);
  const ids = new Map<string, number>();
  for (const slug of slugs) {
    const row = rows.find((r) => r.slug === slug);
    if (!row) throw new Error(`bob cannot read ${slug}`);
    ids.set(slug, row.id);
  }
  return { t, bob, ids };
}

/** A card alice opens is foreign news for bob (T-151), one per call. */
async function plant(f: Fixture, slug: string, title: string): Promise<number> {
  const cookie = await f.t.login();
  const res = await f.t.app.request(`/api/projects/${slug}/issues`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  await settle();
  return (await json(res)).number;
}

async function inboxOf(f: Fixture, qs = "") {
  const res = await f.t.app.request(`/api/me/inbox${qs}`, {
    headers: f.bob.headers,
  });
  expect(res.status).toBe(200);
  return json(res);
}

describe("dedicated: every project is its own group", () => {
  const SLUGS = ["grp-a", "grp-b", "grp-c", "grp-d"];
  let f: Fixture;

  beforeAll(async () => {
    // max_open below the group count on purpose: `inFlight` then runs the
    // four groups in two waves, which is the bounded path rather than a bare
    // Promise.all over everything.
    f = await setUp("dedicated", SLUGS, 2);
  });
  afterAll(async () => {
    await f.t.cleanup();
  });

  it("returns every group's rows, newest first", async () => {
    const planted: { slug: string; number: number }[] = [];
    for (const slug of SLUGS) {
      planted.push({ slug, number: await plant(f, slug, `news in ${slug}`) });
    }

    const page = await inboxOf(f);
    expect(
      page.items.map((i: { project: { slug: string } }) => i.project.slug),
    ).toEqual([...SLUGS].reverse());
    for (const { slug, number } of planted) {
      expect(
        page.items.find(
          (i: { number: number; project: { slug: string } }) =>
            i.project.slug === slug && i.number === number,
        ),
      ).toMatchObject({ unread: true, unread_comments: 1 });
    }
    expect(page.truncated).toBe(false);
  });
});

describe("dedicated-bucketed: one group holds several projects", () => {
  const SLUGS = ["buk-a", "buk-b", "buk-c", "buk-d"];
  let f: Fixture;
  /** Two slugs the url template maps onto the same database. */
  let together: string[];

  beforeAll(async () => {
    f = await setUp("dedicated-bucketed", SLUGS);
    // The template is `…-b${project.id % 2}` (test/helpers.ts), but which
    // ids the system database handed out is not ours to assume — read the
    // grouping back off the router the way getInbox does.
    const rows = await accessibleProjectRows(f.t.ctx, f.bob.user);
    const byUrl = new Map<string, string[]>();
    for (const row of rows) {
      const url = f.t.ctx.router.resolveProjectUrl({
        id: row.id,
        slug: row.slug,
        database_url: row.databaseUrl,
      });
      byUrl.set(url, [...(byUrl.get(url) ?? []), row.slug]);
    }
    const shared = [...byUrl.values()].find((g) => g.length >= 2);
    if (!shared) throw new Error("no two projects share a database");
    together = shared.slice(0, 2);
  });
  afterAll(async () => {
    await f.t.cleanup();
  });

  it("caps and reports truncation per project, not per group", async () => {
    for (const slug of together) {
      for (let i = 0; i < 3; i++) await plant(f, slug, `${slug} #${i}`);
    }

    // Three cards in each of two projects that share one database. Slicing
    // the group as a whole would leave two rows in total; per project it
    // leaves two each, which is what `limit` means (T-97).
    const page = await inboxOf(f, "?limit=2");
    for (const slug of together) {
      const rows = page.items.filter(
        (i: { project: { slug: string } }) => i.project.slug === slug,
      );
      expect(rows).toHaveLength(2);
    }
    expect(page.truncated).toBe(true);

    const full = await inboxOf(f);
    for (const slug of together) {
      expect(
        full.items.filter(
          (i: { project: { slug: string } }) => i.project.slug === slug,
        ),
      ).toHaveLength(3);
    }
    expect(full.truncated).toBe(false);
  });
});
