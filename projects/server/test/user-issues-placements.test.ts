import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import {
  accessibleProjectRows,
  type ProjectRow,
  routeInfoOf,
} from "../src/services/access.ts";
import {
  addUserWithToken,
  makeTestApp,
  type PlacementMode,
  type TestApp,
} from "./helpers.ts";

/**
 * What `GET /api/users/{ref}/issues` owes once several projects answer out of
 * one database: the page still cuts on a per-project cursor, and the mute and
 * unread verdicts still belong to the row's own project rather than to the
 * group. The endpoint's own semantics — role filters, state filters, cursor
 * refusals, visibility — are decided by test/user-issues.test.ts; putting that
 * 500-line fixture through a third placement would re-decide the same cards at
 * triple the cost, the same trade test/inbox-placements.test.ts declines.
 */

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Timestamps carry µs; keep seeded writes apart so merge order is decidable.
 *  The two cards this file asserts on are stamped by hand, but an assertion
 *  added later that leans on the other cards' relative order would silently
 *  become a coin flip without this. */
const settle = () => new Promise((r) => setTimeout(r, 5));

type Item = {
  number: number;
  project: { slug: string };
  unread: boolean;
  unread_comments: number;
  muted: string | null;
};

const keyOf = (i: Item) => `${i.project.slug}/${i.number}`;

const SLUGS = ["uip-a", "uip-b", "uip-c", "uip-d"];

type Fixture = {
  t: TestApp;
  viewer: Awaited<ReturnType<typeof addUserWithToken>>;
  subject: Awaited<ReturnType<typeof addUserWithToken>>;
  rows: Map<string, ProjectRow>;
  /** Cards, as `slug/number`, in creation order per project. */
  cards: Map<string, number[]>;
  headers: () => Record<string, string>;
};

async function setUp(
  placement: PlacementMode,
  maxOpen?: number,
): Promise<Fixture> {
  const t = await makeTestApp(placement, maxOpen ? { maxOpen } : undefined);
  const cookie = await t.login();
  const headers = () => ({ "content-type": "application/json", cookie });
  const viewer = await addUserWithToken(t.ctx, "uip-viewer");
  const subject = await addUserWithToken(t.ctx, "uip-subject");

  for (const slug of SLUGS) {
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    for (const user of [viewer.user, subject.user]) {
      const member = await t.app.request(
        `/api/projects/${slug}/members/${user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(member.status).toBe(204);
    }
  }

  const rows = new Map<string, ProjectRow>();
  for (const row of await accessibleProjectRows(t.ctx, viewer.user)) {
    if (SLUGS.includes(row.slug)) rows.set(row.slug, row);
  }
  expect(rows.size).toBe(SLUGS.length);

  return { t, viewer, subject, rows, cards: new Map(), headers };
}

/** Opened by the subject: the page is about their cards. */
async function openCard(f: Fixture, slug: string, title: string) {
  const res = await f.t.app.request(`/api/projects/${slug}/issues`, {
    method: "POST",
    headers: { "content-type": "application/json", ...f.subject.headers },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  await settle();
  const number = (await json(res)).number as number;
  f.cards.set(slug, [...(f.cards.get(slug) ?? []), number]);
  return number;
}

async function list(
  f: Fixture,
  params: Record<string, string>,
): Promise<{ items: Item[]; next_cursor: string | null; has_more: boolean }> {
  const res = await f.t.app.request(
    `/api/users/${f.subject.user.login}/issues?${new URLSearchParams(params)}`,
    { headers: f.viewer.headers },
  );
  expect(res.status).toBe(200);
  return (await json(res)) as {
    items: Item[];
    next_cursor: string | null;
    has_more: boolean;
  };
}

/** Every page of the stream at `limit`, in order. */
async function drain(f: Fixture, limit: number): Promise<Item[][]> {
  const pages: Item[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 40; i++) {
    const page = await list(f, {
      limit: String(limit),
      ...(cursor === null ? {} : { after: cursor }),
    });
    pages.push(page.items);
    cursor = page.next_cursor;
    if (!page.has_more) return pages;
  }
  throw new Error("the stream never ended");
}

describe.each(["shared", "dedicated-bucketed"] as const)(
  "projects sharing a database (%s placement)",
  (placement) => {
    let f: Fixture;
    /** Two projects in one database, named by which holds the bigger id. */
    let high: ProjectRow;
    let low: ProjectRow;
    /** The tie pair: one card in each, stamped to the same microsecond. */
    let highTie = 0;
    let lowTie = 0;

    beforeAll(async () => {
      f = await setUp(placement);
      const byUrl = new Map<string, ProjectRow[]>();
      for (const row of f.rows.values()) {
        const url = f.t.ctx.router.resolveProjectUrl(routeInfoOf(row));
        byUrl.set(url, [...(byUrl.get(url) ?? []), row]);
      }
      const together = [...byUrl.values()].find((g) => g.length >= 2);
      if (together === undefined) throw new Error("no two projects share a db");
      const pair = [...together].sort((a, b) => a.id - b.id);
      low = pair[0] as ProjectRow;
      high = pair[pair.length - 1] as ProjectRow;

      for (const slug of SLUGS) await openCard(f, slug, `${slug} plain`);
      // High first, low second: they share an `issues` sequence, so the card
      // that sorts first by project must be the one with the *smaller* row
      // id — otherwise breaking the project tie-break looks identical to
      // honouring it.
      highTie = await openCard(f, high.slug, "tie in the high project");
      lowTie = await openCard(f, low.slug, "tie in the low project");
      for (const slug of SLUGS) {
        if (slug !== high.slug && slug !== low.slug) {
          await openCard(f, slug, `${slug} second`);
        }
      }

      const stamp = new Date("2033-01-01T00:00:00.000321Z");
      for (const [project, number] of [
        [high, highTie],
        [low, lowTie],
      ] as const) {
        const db = await f.t.ctx.router.forProject(routeInfoOf(project));
        await db
          .update(issues)
          .set({ updatedAt: stamp })
          .where(
            and(eq(issues.projectId, project.id), eq(issues.number, number)),
          );
      }

      // Mints the viewer's read frontiers while nothing foreign has happened
      // yet, so the comment Case 3 writes is the only unread in the fixture.
      const warm = await list(f, { limit: "100" });
      expect(warm.items).toHaveLength(8);
    }, 120_000);

    afterAll(async () => {
      await f.t.cleanup();
    });

    const idOfCard = async (project: ProjectRow, number: number) => {
      const db = await f.t.ctx.router.forProject(routeInfoOf(project));
      const found = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(eq(issues.projectId, project.id), eq(issues.number, number)),
        );
      const row = found[0];
      if (!row) throw new Error("fixture card vanished");
      return row.id;
    };

    it("semantic watchdog: a cross-project tie on the cut is not skipped", async () => {
      const idHigh = await idOfCard(high, highTie);
      const idLow = await idOfCard(low, lowTie);
      // The fixture's premise as an assertion: if ids stop being handed out
      // in creation order, this is what goes red, rather than an ordering
      // assertion nobody can read.
      expect(idLow).toBeGreaterThan(idHigh);

      const pages = await drain(f, 1);
      expect(pages[0]?.map(keyOf)).toEqual([`${high.slug}/${highTie}`]);
      expect(pages[1]?.map(keyOf)).toEqual([`${low.slug}/${lowTie}`]);
      const seen = pages.flat().map(keyOf);
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
    });

    it("semantic watchdog: a project mute stops at its own project", async () => {
      const muted = await f.t.app.request(`/api/projects/${high.slug}/mute`, {
        method: "PUT",
        headers: f.viewer.headers,
      });
      expect(muted.status).toBe(204);
      try {
        const page = await list(f, { limit: "100" });
        const mutedOf = (slug: string) =>
          page.items.filter((i) => i.project.slug === slug).map((i) => i.muted);
        expect(mutedOf(high.slug)).toEqual(["project", "project"]);
        expect(mutedOf(low.slug)).toEqual([null, null]);
      } finally {
        const cleared = await f.t.app.request(
          `/api/projects/${high.slug}/mute`,
          { method: "DELETE", headers: f.viewer.headers },
        );
        expect(cleared.status).toBe(204);
      }
    });

    it("semantic watchdog: unread is charged to the row's own project", async () => {
      const target = f.cards.get(low.slug)?.[0];
      if (target === undefined) throw new Error("low project has no card");
      const posted = await f.t.app.request(
        `/api/projects/${low.slug}/issues/${target}/comments`,
        {
          method: "POST",
          headers: f.headers(),
          body: JSON.stringify({ body: "someone else says something" }),
        },
      );
      expect(posted.status).toBe(201);

      const page = await list(f, { limit: "100" });
      const unread = page.items.filter((i) => i.unread).map(keyOf);
      expect(unread).toEqual([`${low.slug}/${target}`]);
      const counts = page.items.find((i) => keyOf(i) === unread[0]);
      expect(counts?.unread_comments).toBe(1);
      expect(
        page.items
          .filter((i) => i.project.slug === high.slug)
          .map((i) => i.unread),
      ).toEqual([false, false]);
    });

    it("semantic watchdog: every card resolves its own project's status", async () => {
      const page = await list(f, { limit: "100" });
      expect(page.items).toHaveLength(8);
    });
  },
);

describe("dedicated placement, max_open below the group count", () => {
  let f: Fixture;

  beforeAll(async () => {
    // Four databases and room for two handles, the pairing
    // test/inbox-placements.test.ts uses for the same reason.
    f = await setUp("dedicated", 2);
    for (const slug of SLUGS) {
      await openCard(f, slug, `${slug} plain`);
      await openCard(f, slug, `${slug} second`);
    }
  }, 120_000);

  afterAll(async () => {
    await f.t.cleanup();
  });

  /**
   * These two cover `perDatabase` scheduling the groups in waves — four
   * groups through two slots — and nothing else. They do not observe
   * eviction: `#evictIfNeeded` hands a `pglite://memory` handle straight
   * back, so "a handle in flight is never closed" is unobservable in any
   * endpoint-level fixture and this file does not pretend otherwise. They
   * guard new code rather than proving a win — before this card
   * `perDatabase` was not in the picture at all.
   */
  it("delivers every card when the groups outnumber the open handles", async () => {
    const page = await list(f, { limit: "100" });
    expect(page.items).toHaveLength(8);
  });

  it("pages over every card exactly once across the waves", async () => {
    const seen = (await drain(f, 1)).flat().map(keyOf);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });
});
