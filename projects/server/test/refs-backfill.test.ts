import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  comments,
  issueEvents,
  issues,
  revisions,
} from "../src/db/project-schema.ts";
import { systemSettings } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { backfillRefs } from "../src/services/refs-backfill.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const A = "bf-a";
const B = "bf-b";

/**
 * `refs backfill` pays the respell the cards moved before T-247 never got.
 *
 * The fixture is a real move with its rewrite undone afterwards, rather than
 * hand-seeded rows: the walk reads the `moved_in` event's own `id_map` and
 * actor, and only a genuine move writes those the way production does.
 */
describe("refs backfill", () => {
  let t: TestApp;
  let cookie: string;
  const id: Record<string, number> = {};
  let card: { id: number; number: number };
  let bareBody = "";
  let bareComment = "";
  let anchoredOldId = 0;
  let oldNumber = 0;
  let mover = 0;

  const headers = () => ({ "content-type": "application/json", cookie });
  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: init?.body ? headers() : { cookie },
    });

  const dbOf = async (slug: string) =>
    t.ctx.router.forProject(
      routeInfoOf({
        id: id[slug] as number,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );

  const landedBody = async () => {
    const db = await dbOf(B);
    const [row] = await db
      .select({ body: issues.body })
      .from(issues)
      .where(eq(issues.id, card.id));
    return row?.body ?? "";
  };

  const landedComments = async () => {
    const db = await dbOf(B);
    return db
      .select({ id: comments.id, body: comments.body })
      .from(comments)
      .where(eq(comments.issueId, card.id))
      .orderBy(comments.id);
  };

  const backfill = (dryRun: boolean, slug?: string) =>
    backfillRefs(t.ctx, {
      dryRun,
      ...(slug === undefined ? {} : { slug }),
      log: () => {},
    });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    for (const slug of [A, B]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      id[slug] = ((await json(res)) as { id: number }).id;
    }
    await t.ctx.router
      .system()
      .update(systemSettings)
      .set({ value: new Date("2020-01-01T00:00:00Z").toISOString() })
      .where(eq(systemSettings.key, "cross_refs_since"));

    const target = await json(
      await req(`/projects/${A}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "target in A", body: "" }),
      }),
    );
    const source = await json(
      await req(`/projects/${A}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: "moved long ago",
          body: `points at #${target.number}`,
        }),
      }),
    );
    oldNumber = source.number;
    const anchored = await json(
      await req(`/projects/${A}/issues/${source.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "the anchored one" }),
      }),
    );
    anchoredOldId = anchored.id;
    const pointing = await json(
      await req(`/projects/${A}/issues/${source.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: `back to #comment-${anchored.id}` }),
      }),
    );
    bareBody = `points at #${target.number}`;
    bareComment = `back to #comment-${anchored.id}`;

    const moved = await json(
      await req(`/projects/${A}/issues/${source.number}/move`, {
        method: "POST",
        body: JSON.stringify({ to_project: B }),
      }),
    );
    const db = await dbOf(B);
    const [landed] = await db
      .select({ id: issues.id, number: issues.number })
      .from(issues)
      .where(
        and(
          eq(issues.projectId, id[B] as number),
          eq(issues.number, moved.moved_to.number),
        ),
      );
    card = { id: landed?.id as number, number: landed?.number as number };

    // Undo the move's own rewrite, leaving exactly what a pre-T-247 move
    // left: the copy, its `moved_in` event, and the text as typed.
    await db
      .update(issues)
      .set({ body: bareBody })
      .where(eq(issues.id, card.id));
    const copied = await landedComments();
    const pointingNew = copied.find((row) => row.body.startsWith("back to"));
    await db
      .update(comments)
      .set({ body: bareComment })
      .where(eq(comments.id, pointingNew?.id as number));
    await db.delete(revisions).where(eq(revisions.projectId, id[B] as number));

    const [event] = await db
      .select({ actorId: issueEvents.actorId })
      .from(issueEvents)
      .where(
        and(eq(issueEvents.issueId, card.id), eq(issueEvents.type, "moved_in")),
      );
    mover = event?.actorId as number;
    expect(pointing.id).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("counts what it would rewrite and writes nothing", async () => {
    const report = await backfill(true);
    expect(report.issues).toBe(1);
    expect(report.changed).toBe(2);
    expect(report.rewritten).toBe(2);
    expect(report.skipped).toBe(0);
    expect(await landedBody()).toBe(bareBody);
  });

  it("skips a project with no moved cards", async () => {
    const report = await backfill(true, A);
    expect(report.projects).toBe(1);
    expect(report.issues).toBe(0);
    expect(report.changed).toBe(0);
  });

  it("respells the card and records the move's actor on the revision", async () => {
    const report = await backfill(false);
    expect(report.changed).toBe(2);

    expect(await landedBody()).toBe(bareBody.replace("#", `${A}#`));
    const copied = await landedComments();
    const pointingNew = copied.find((row) => row.body.startsWith("back to"));
    // The old address rather than the new id: this walk has no promise that
    // it is running for the first time.
    expect(pointingNew?.body).toBe(
      `back to ${A}#${oldNumber}#comment-${anchoredOldId}`,
    );

    const db = await dbOf(B);
    const bodyRevisions = await db
      .select({ body: revisions.body, actorId: revisions.actorId })
      .from(revisions)
      .where(
        and(
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, card.id),
        ),
      );
    expect(bodyRevisions).toEqual([{ body: bareBody, actorId: mover }]);
  });

  it("finds nothing left to do on a second run", async () => {
    const again = await backfill(false);
    expect(again.issues).toBe(1);
    expect(again.changed).toBe(0);
    expect(again.rewritten).toBe(0);
    expect(again.skipped).toBe(0);

    const db = await dbOf(B);
    expect(
      await db
        .select({ id: revisions.id })
        .from(revisions)
        .where(eq(revisions.projectId, id[B] as number)),
    ).toHaveLength(2);
  });
});
