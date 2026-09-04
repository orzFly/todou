import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comments, issueEvents, issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { backfillRefs } from "../src/services/refs-backfill.ts";
import { microIso } from "../src/services/timeline.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The precision regression the in-memory suite is structurally blind to:
 * PGlite's clock only produces millisecond timestamps, so a copy that
 * truncates looks perfect there. Real postgres stores microseconds, and the
 * timeline cursor is `(created_at µs, kind, id)` — a truncating copy
 * silently reorders the card's own history (T-231, the same blind spot
 * T-77 has).
 *
 * Asserted against the stored columns rather than the API: responses render
 * `created_at` from a JS Date and have always been millisecond-precision.
 * The microseconds only ever mattered to the cursor.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test issue-move-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("moving an issue on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  // The database persists across runs; unique slugs isolate each one.
  const run = Date.now().toString(36);
  const A = `mvpg-a-${run}`;
  const B = `mvpg-b-${run}`;
  const ids: Record<string, number> = {};

  const headers = () => ({ "content-type": "application/json", cookie });
  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body ? headers() : { cookie },
    });

  const stampsOf = async (projectId: number, issueId: number) => {
    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: projectId,
        slug: "",
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const rows = await db
      .select({ body: comments.body, at: microIso(comments.createdAt) })
      .from(comments)
      .where(eq(comments.issueId, issueId))
      .orderBy(comments.createdAt, comments.id);
    return rows;
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    for (const slug of [A, B]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      ids[slug] = ((await json(res)) as { id: number }).id;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("copies created_at to the microsecond", async () => {
    const created = await json(
      await req(`/projects/${A}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "precise history", body: "body" }),
      }),
    );
    // Written back to back on purpose: consecutive comments land inside one
    // millisecond, so only the microseconds keep them ordered.
    for (const body of ["one", "two", "three", "four", "five"]) {
      const res = await req(
        `/projects/${A}/issues/${created.number}/comments`,
        { method: "POST", body: JSON.stringify({ body }) },
      );
      expect(res.status).toBe(201);
    }

    const before = await stampsOf(ids[A] as number, created.id);
    expect(before).toHaveLength(5);
    // Guards the guard: with no sub-millisecond digits in the fixture, this
    // test would also pass against a copy that truncates.
    expect(before.some((row) => /\.\d{3}[1-9]/.test(row.at))).toBe(true);

    const moved = await json(
      await req(`/projects/${A}/issues/${created.number}/move`, {
        method: "POST",
        body: JSON.stringify({ to_project: B, dry_run: false }),
      }),
    );
    const landed = await t.ctx.router
      .system()
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.id, moved.issue.id));
    expect(landed).toHaveLength(1);

    const after = await stampsOf(ids[B] as number, moved.issue.id);
    expect(after.map((row) => row.body)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
    ]);
    expect(after.map((row) => row.at)).toEqual(before.map((row) => row.at));
  });

  it("respells up to the move's instant and no further", async () => {
    // The boundary `ownerAt` fixes and the respell has to share: content
    // stamped exactly at the move belongs to the new home, so it is already
    // spelled for it. PGlite cannot show this — its clock has no
    // sub-millisecond digits, so nothing distinguishes "at the move" from
    // "just before it" there.
    const target = await json(
      await req(`/projects/${A}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "boundary target", body: "" }),
      }),
    );
    const card = await json(
      await req(`/projects/${B}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "sits on the boundary", body: "" }),
      }),
    );
    const before = await json(
      await req(`/projects/${B}/issues/${card.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `earlier #${target.number}` }),
      }),
    );
    const onTheDot = await json(
      await req(`/projects/${B}/issues/${card.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `exactly #${target.number}` }),
      }),
    );

    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: ids[B] as number,
        slug: B,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const [row] = await db
      .select({ authorId: issues.authorId })
      .from(issues)
      .where(eq(issues.id, card.id));
    // Ahead of now, so both comments stay clear of this deployment's
    // `cross_refs_since` — a fresh database seeds that at migration time.
    const at = new Date(Date.now() + 60_000);
    await db
      .update(comments)
      .set({ createdAt: new Date(at.getTime() - 1) })
      .where(eq(comments.id, before.id));
    await db
      .update(comments)
      .set({ createdAt: at })
      .where(eq(comments.id, onTheDot.id));
    await db.insert(issueEvents).values({
      projectId: ids[B] as number,
      issueId: card.id,
      actorId: row?.authorId as number,
      type: "moved_in",
      createdAt: at,
      payload: {
        move_token: `boundary-${run}`,
        lineage: 1,
        from_project_id: ids[A],
        from_project: A,
        from_number: 4242,
      },
    });

    const report = await backfillRefs(t.ctx, {
      dryRun: false,
      slug: B,
      log: () => {},
    });
    expect(report.changed).toBe(1);

    const bodies = await db
      .select({ id: comments.id, body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, card.id));
    expect(bodies.find((c) => c.id === before.id)?.body).toBe(
      `earlier ${A}#${target.number}`,
    );
    expect(bodies.find((c) => c.id === onTheDot.id)?.body).toBe(
      `exactly #${target.number}`,
    );
  });

  it("orders the copied timeline the way the source was ordered", async () => {
    const created = await json(
      await req(`/projects/${A}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "ordering", body: "body" }),
      }),
    );
    const bodies = ["alpha", "beta", "gamma", "delta"];
    for (const body of bodies) {
      await req(`/projects/${A}/issues/${created.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    }
    const moved = await json(
      await req(`/projects/${A}/issues/${created.number}/move`, {
        method: "POST",
        body: JSON.stringify({ to_project: B, dry_run: false }),
      }),
    );

    // Read through the API, which merges comments and events on the same
    // (created_at, kind, id) order the cursor walks.
    const page = await json(
      await req(
        `/projects/${B}/issues/${moved.moved_to.number}/timeline?limit=100`,
      ),
    );
    expect(
      page.items
        .filter((item: { type: string }) => item.type === "comment")
        .map((item: { body: string }) => item.body),
    ).toEqual(bodies);
  });
});
