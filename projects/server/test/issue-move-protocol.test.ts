import { and, eq, inArray, max, ne, or } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  revisions,
} from "../src/db/project-schema.ts";
import { issueAddresses, issueMoves } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import type { ActivityImportedMaxIds } from "../src/services/move/copy.ts";
import { sweepMoves } from "../src/services/move/execute.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;
type Step = 1 | 2 | 3 | 4 | 5 | 6;
type MovedInEvent = typeof issueEvents.$inferSelect & {
  payload: Record<string, unknown> & {
    activity_imported_max_ids?: ActivityImportedMaxIds;
  };
};

const movedInFor = async (db: Db, projectId: number): Promise<MovedInEvent> => {
  const rows = await db
    .select()
    .from(issueEvents)
    .where(
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "moved_in"),
      ),
    );
  expect(rows).toHaveLength(1);
  const row = rows[0] as typeof issueEvents.$inferSelect;
  return { ...row, payload: row.payload as MovedInEvent["payload"] };
};

/** Read the copied rows independently of the boundary stored in moved_in. */
const copiedActivityMaxIds = async (
  db: Db,
  projectId: number,
  issueId: number,
): Promise<ActivityImportedMaxIds> => {
  const [events, copiedComments, copiedRevisions] = await Promise.all([
    db
      .select({ id: max(issueEvents.id) })
      .from(issueEvents)
      .where(
        and(eq(issueEvents.issueId, issueId), ne(issueEvents.type, "moved_in")),
      ),
    db
      .select({ id: max(comments.id) })
      .from(comments)
      .where(eq(comments.issueId, issueId)),
    db
      .select({ id: max(revisions.id) })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, projectId),
          or(
            and(
              eq(revisions.subjectType, "issue_body"),
              eq(revisions.subjectId, issueId),
            ),
            and(
              eq(revisions.subjectType, "comment"),
              inArray(
                revisions.subjectId,
                db
                  .select({ id: comments.id })
                  .from(comments)
                  .where(eq(comments.issueId, issueId)),
              ),
            ),
          ),
        ),
      ),
  ]);
  return {
    v: 1,
    events: events[0]?.id ?? null,
    comments: copiedComments[0]?.id ?? null,
    revisions: copiedRevisions[0]?.id ?? null,
  };
};

/** Direct rows also let us exercise the unpublished copy after step 3. */
const addActivity = async (db: Db, projectId: number, issueId: number) => {
  const [issue] = await db
    .select({ authorId: issues.authorId })
    .from(issues)
    .where(eq(issues.id, issueId));
  const actorId = issue?.authorId as number;
  const [event] = await db
    .insert(issueEvents)
    .values({
      projectId,
      issueId,
      actorId,
      type: "title_changed",
      payload: { from: "before", to: "after" },
    })
    .returning({ id: issueEvents.id });
  const [comment] = await db
    .insert(comments)
    .values({ projectId, issueId, authorId: actorId, body: "activity" })
    .returning({ id: comments.id });
  const addedRevisions = await db
    .insert(revisions)
    .values([
      {
        projectId,
        subjectType: "issue_body",
        subjectId: issueId,
        actorId,
        body: "previous body",
      },
      {
        projectId,
        subjectType: "comment",
        subjectId: comment?.id as number,
        actorId,
        body: "first comment body",
      },
      {
        projectId,
        subjectType: "comment",
        subjectId: comment?.id as number,
        actorId,
        body: "second comment body",
      },
    ])
    .returning({ id: revisions.id });
  return {
    events: event?.id as number,
    comments: comment?.id as number,
    revisions: Math.max(...addedRevisions.map((row) => row.id)),
  };
};

const expectPreservedAcrossSweeps = async (
  t: TestApp,
  db: Db,
  projectId: number,
  committed: MovedInEvent,
  firstSweep = 1,
) => {
  const boundary = committed.payload.activity_imported_max_ids;
  for (const recovered of [firstSweep, 0, 0]) {
    const later = await addActivity(db, projectId, committed.issueId);
    for (const kind of ["events", "comments", "revisions"] as const) {
      expect(later[kind]).toBeGreaterThan(boundary?.[kind] ?? 0);
    }
    expect(later.events).toBeGreaterThan(committed.id);
    expect(await sweepMoves(t.ctx)).toBe(recovered);
    // Exact equality checks all three values, null keys, legacy absence,
    // the original event id, and the id map needed to finish recovery.
    expect(await movedInFor(db, projectId)).toStrictEqual(committed);
  }
};

/**
 * The cross-database protocol, interrupted on purpose.
 *
 * With no transaction spanning the two databases, "it recovers" is not
 * something the happy path can demonstrate — every one of these tests kills
 * the move between two steps and asserts that `sweepMoves` reaches the same
 * end state the uninterrupted move would have.
 */
describe.each(["dedicated", "dedicated-bucketed"] as const)(
  "cross-database move protocol (%s placement)",
  (placement) => {
    const A = `pmv-a-${placement}`;
    const B = `pmv-b-${placement}`;

    /** A fresh app per test: the injected failure is per-run, not per-suite. */
    const setup = async (failAt?: Step) => {
      const t = await makeTestApp(placement, undefined, {
        afterMoveStep: async (step) => {
          if (step === failAt) throw new Error(`injected failure at ${step}`);
        },
      });
      const cookie = await t.login();
      const admin: Who = { cookie };
      const ids: Record<string, number> = {};
      for (const slug of [A, B]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
        ids[slug] = ((await json(res)) as { id: number }).id;
      }
      return { t, admin, cookie, ids };
    };

    let open: TestApp | null = null;
    const app = async (failAt?: Step) => {
      const made = await setup(failAt);
      open = made.t;
      return made;
    };

    afterEach(async () => {
      await open?.cleanup();
      open = null;
    });

    const req = (t: TestApp, path: string, who: Who, init?: RequestInit) =>
      t.app.request(`/api${path}`, {
        ...init,
        headers: {
          ...(init?.body
            ? { "content-type": "application/json", ...who }
            : who),
          ...init?.headers,
        },
      });

    const createIssue = async (
      t: TestApp,
      who: Who,
      slug: string,
      title: string,
    ) => {
      const res = await req(t, `/projects/${slug}/issues`, who, {
        method: "POST",
        body: JSON.stringify({ title, body: "body" }),
      });
      expect(res.status).toBe(201);
      return (await json(res)) as { id: number; number: number };
    };

    const dbOf = async (t: TestApp, id: number, slug: string) =>
      t.ctx.router.forProject(
        routeInfoOf({ id, slug, databaseUrl: null } as Parameters<
          typeof routeInfoOf
        >[0]),
      );

    const move = (
      t: TestApp,
      who: Who,
      from: string,
      number: number,
      to: string,
    ) =>
      req(t, `/projects/${from}/issues/${number}/move`, who, {
        method: "POST",
        body: JSON.stringify({ to_project: to }),
      });

    it("finishes a move that died before the address book", async () => {
      const { t, admin, ids } = await app(3);
      const source = await createIssue(t, admin, A, "interrupted at 3");
      const comment = await req(
        t,
        `/projects/${A}/issues/${source.number}/comments`,
        admin,
        { method: "POST", body: JSON.stringify({ body: "travels" }) },
      );
      const oldCommentId = ((await json(comment)) as { id: number }).id;
      const dbA = await dbOf(t, ids[A] as number, A);
      await addActivity(dbA, ids[A] as number, source.id);

      expect((await move(t, admin, A, source.number, B)).status).toBe(500);
      const dbB = await dbOf(t, ids[B] as number, B);
      const committed = await movedInFor(dbB, ids[B] as number);
      const boundary = await copiedActivityMaxIds(
        dbB,
        ids[B] as number,
        committed.issueId,
      );
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        expect(boundary[kind]).toBeGreaterThan(0);
      }
      expect(boundary.events).toBeLessThan(committed.id);

      // Frozen, not gone: reads pass, writes do not, and no redirect yet.
      const read = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
      );
      expect(read.status).toBe(200);
      const write = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
        { method: "PATCH", body: JSON.stringify({ title: "nope" }) },
      );
      expect(write.status).toBe(409);
      expect((await json(write)).error.code).toBe("issue_moving");

      await expectPreservedAcrossSweeps(t, dbB, ids[B] as number, committed);

      // Converged: the tombstone redirects, and exactly one copy exists.
      const after = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
      );
      expect(after.status).toBe(301);
      const to = (await json(after)).moved_to as {
        slug: string;
        number: number;
      };
      expect(to.slug).toBe(B);

      const copies = await dbB
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, ids[B] as number));
      expect(copies).toHaveLength(1);

      // The aliases landed too — which is only possible if the id map
      // survived the crash inside the moved_in event.
      const aliased = await req(
        t,
        `/projects/${A}/comments/${oldCommentId}`,
        admin,
      );
      expect(aliased.status).toBe(301);
      expect((await json(aliased)).moved_to.slug).toBe(B);
    });

    it("finishes a move that died after the commit point", async () => {
      const { t, admin, ids } = await app(4);
      const source = await createIssue(t, admin, A, "interrupted at 4");
      const dbA = await dbOf(t, ids[A] as number, A);
      await addActivity(dbA, ids[A] as number, source.id);
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      // The window the design admits to: past step 4 the copy is live and
      // the source has not been retired yet, so both are readable.
      const dbB = await dbOf(t, ids[B] as number, B);
      const committed = await movedInFor(dbB, ids[B] as number);
      const boundary = await copiedActivityMaxIds(
        dbB,
        ids[B] as number,
        committed.issueId,
      );
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        expect(boundary[kind]).toBeGreaterThan(0);
      }
      expect(boundary.events).toBeLessThan(committed.id);
      const copies = await dbB
        .select({ number: issues.number })
        .from(issues)
        .where(eq(issues.projectId, ids[B] as number));
      expect(copies).toHaveLength(1);
      const copyNumber = copies[0]?.number as number;
      expect(
        (await req(t, `/projects/${B}/issues/${copyNumber}`, admin)).status,
      ).toBe(200);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(200);

      await expectPreservedAcrossSweeps(t, dbB, ids[B] as number, committed);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    describe.each([3, 4] as const)(
      "empty-source recovery at step %s",
      (step) => {
        it.each(["legacy absent", "explicit all-null"] as const)(
          "preserves a %s watermark",
          async (watermark) => {
            const { t, admin, ids } = await app(step);
            const source = await createIssue(t, admin, A, "no source activity");
            const dbA = await dbOf(t, ids[A] as number, A);
            // Issue creation normally emits opened; remove it to model an
            // imported card with no events, comments, or revisions at all.
            await dbA
              .delete(issueEvents)
              .where(eq(issueEvents.issueId, source.id));
            const empty = {
              v: 1,
              events: null,
              comments: null,
              revisions: null,
            };
            expect(
              await copiedActivityMaxIds(dbA, ids[A] as number, source.id),
            ).toStrictEqual(empty);
            expect((await move(t, admin, A, source.number, B)).status).toBe(
              500,
            );

            const dbB = await dbOf(t, ids[B] as number, B);
            let committed = await movedInFor(dbB, ids[B] as number);
            expect(committed.payload.activity_imported_max_ids).toStrictEqual(
              empty,
            );
            if (watermark === "legacy absent") {
              // Model an event committed by a server predating watermarks;
              // keep its move token and id map so real recovery still runs.
              const payload = { ...committed.payload };
              delete payload.activity_imported_max_ids;
              await dbB
                .update(issueEvents)
                .set({ payload })
                .where(eq(issueEvents.id, committed.id));
              committed = await movedInFor(dbB, ids[B] as number);
              expect(
                Object.hasOwn(committed.payload, "activity_imported_max_ids"),
              ).toBe(false);
            }

            await expectPreservedAcrossSweeps(
              t,
              dbB,
              ids[B] as number,
              committed,
            );
            expect(
              (await req(t, `/projects/${A}/issues/${source.number}`, admin))
                .status,
            ).toBe(301);
            const recovered = await movedInFor(dbB, ids[B] as number);
            expect(
              Object.hasOwn(recovered.payload, "activity_imported_max_ids"),
            ).toBe(watermark === "explicit all-null");
            if (watermark === "explicit all-null") {
              expect(recovered.payload.activity_imported_max_ids).toStrictEqual(
                empty,
              );
            }
          },
        );
      },
    );

    it("rolls back a move that died before anything was copied", async () => {
      const { t, admin, ids } = await app(2);
      const source = await createIssue(t, admin, A, "interrupted at 2");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);
      const [interrupted] = await t.ctx.router
        .system()
        .select()
        .from(issueMoves);
      expect(interrupted?.state).toBe("copying");

      expect(await sweepMoves(t.ctx)).toBe(1);
      expect(await sweepMoves(t.ctx)).toBe(0);

      // Thawed and forgotten: the card is writable again and no registration
      // row is left for a later sweep to act on.
      const write = await req(
        t,
        `/projects/${A}/issues/${source.number}`,
        admin,
        { method: "PATCH", body: JSON.stringify({ title: "writable again" }) },
      );
      expect(write.status).toBe(200);
      expect(
        await t.ctx.router.system().select().from(issueMoves),
      ).toHaveLength(0);
      const dbB = await dbOf(t, ids[B] as number, B);
      expect(
        await dbB
          .select()
          .from(issues)
          .where(eq(issues.projectId, ids[B] as number)),
      ).toHaveLength(0);
      expect(
        await dbB
          .select()
          .from(issueEvents)
          .where(eq(issueEvents.projectId, ids[B] as number)),
      ).toHaveLength(0);

      // New source activity belongs to the next copy, not the abandoned
      // pre-copy attempt. Retry through the endpoint with the fault removed.
      const dbA = await dbOf(t, ids[A] as number, A);
      await addActivity(dbA, ids[A] as number, source.id);
      t.ctx.testHooks = {};
      expect((await move(t, admin, A, source.number, B)).status).toBe(200);
      const committed = await movedInFor(dbB, ids[B] as number);
      expect(committed.payload.move_token).toEqual(expect.any(String));
      expect(committed.payload.move_token).not.toBe(interrupted?.moveToken);
      const boundary = await copiedActivityMaxIds(
        dbB,
        ids[B] as number,
        committed.issueId,
      );
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        expect(boundary[kind]).toBeGreaterThan(0);
      }
      expect(boundary.events).toBeLessThan(committed.id);
      await expectPreservedAcrossSweeps(t, dbB, ids[B] as number, committed, 0);
    });

    it("leaves one moved_out however often the sweep runs", async () => {
      const { t, admin, ids } = await app(5);
      const source = await createIssue(t, admin, A, "interrupted at 5");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      await sweepMoves(t.ctx);
      await sweepMoves(t.ctx);

      const dbA = await dbOf(t, ids[A] as number, A);
      const trace = await dbA
        .select({ id: issueEvents.id })
        .from(issueEvents)
        .where(
          and(
            eq(issueEvents.issueId, source.id),
            eq(issueEvents.type, "moved_out"),
          ),
        );
      // The source project's only remaining record of the card; a replayed
      // step 5 must not turn it into two.
      expect(trace).toHaveLength(1);
    });

    it("refuses a second move during the freeze and leaves no second row", async () => {
      const { t, admin } = await app(3);
      const source = await createIssue(t, admin, A, "contested");
      expect((await move(t, admin, A, source.number, B)).status).toBe(500);

      const second = await move(t, admin, A, source.number, B);
      expect(second.status).toBe(409);
      expect((await json(second)).error.code).toBe("issue_moving");
      const rows = await t.ctx.router.system().select().from(issueMoves);
      expect(rows).toHaveLength(1);

      // …and the sweep still finishes the first move rather than thawing it.
      expect(await sweepMoves(t.ctx)).toBe(1);
      expect(
        (await req(t, `/projects/${A}/issues/${source.number}`, admin)).status,
      ).toBe(301);
    });

    it("keeps the address book flat for every address the card has had", async () => {
      const { t, admin, ids } = await app();
      const source = await createIssue(t, admin, A, "walks the book");
      const out = await json(await move(t, admin, A, source.number, B));
      const back = await json(await move(t, admin, B, out.moved_to.number, A));

      const rows = await t.ctx.router
        .system()
        .select()
        .from(issueAddresses)
        .where(eq(issueAddresses.projectId, ids[A] as number));
      expect(rows).toHaveLength(1);
      // Every address of a lineage points at the same place — the invariant
      // that makes resolution one lookup instead of a chase.
      const all = await t.ctx.router.system().select().from(issueAddresses);
      const targets = new Set(
        all.map((r) => `${r.currentProjectId}/${r.currentNumber}`),
      );
      expect(targets.size).toBe(1);
      expect([...targets][0]).toBe(`${ids[A]}/${back.moved_to.number}`);
    });
  },
);

/**
 * Two projects in ONE dedicated database while the system tables sit
 * elsewhere: the deployment that makes the two path judgements disagree.
 */
describe("two projects sharing a database", () => {
  it("takes the protocol path without colliding on the storage key", async () => {
    const t = await makeTestApp("dedicated-bucketed");
    try {
      const cookie = await t.login();
      const headers = { "content-type": "application/json", cookie };
      const created: Array<{ slug: string; id: number }> = [];
      // `project.id % 2` buckets them, so the first and third share a target.
      for (const slug of ["bkt-one", "bkt-two", "bkt-three"]) {
        const res = await t.app.request("/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
        created.push({ slug, id: ((await json(res)) as { id: number }).id });
      }
      const pair = created.filter(
        (p) => p.id % 2 === (created[0] as { id: number }).id % 2,
      );
      expect(pair.length).toBeGreaterThanOrEqual(2);
      const from = pair[0] as { slug: string; id: number };
      const to = pair[1] as { slug: string; id: number };

      const issue = await json(
        await t.app.request(`/api/projects/${from.slug}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "carries a file", body: "body" }),
        }),
      );
      const form = new FormData();
      form.set(
        "file",
        new File(["bytes"], "shared.txt", { type: "text/plain" }),
      );
      form.set("issue_number", String(issue.number));
      const uploaded = await t.app.request(
        `/api/projects/${from.slug}/attachments`,
        { method: "POST", headers: { cookie }, body: form },
      );
      expect(uploaded.status).toBe(201);
      const db = await t.ctx.router.forProject(
        routeInfoOf({ ...to, databaseUrl: null } as Parameters<
          typeof routeInfoOf
        >[0]),
      );
      await addActivity(db, from.id, issue.id);
      const sourceBoundary = await copiedActivityMaxIds(db, from.id, issue.id);

      // The copy keeps the storage key, and the unique index on it spans the
      // whole database — so the source row has to go first even though this
      // is the cross-database path.
      const res = await t.app.request(
        `/api/projects/${from.slug}/issues/${issue.number}/move`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ to_project: to.slug }),
        },
      );
      expect(res.status).toBe(200);
      const moved = await json(res);
      expect(moved.moved_to.slug).toBe(to.slug);
      const committed = await movedInFor(db, to.id);
      const boundary = await copiedActivityMaxIds(db, to.id, committed.issueId);
      expect(committed.payload.activity_imported_max_ids).toStrictEqual(
        boundary,
      );
      for (const kind of ["events", "comments", "revisions"] as const) {
        // Shared sequences make source ids plausible but wrong boundaries.
        expect(boundary[kind]).toBeGreaterThan(sourceBoundary[kind] as number);
      }
      expect(boundary.events).toBeLessThan(committed.id);
      await expectPreservedAcrossSweeps(t, db, to.id, committed, 0);

      const listed = await t.app.request(
        `/api/projects/${to.slug}/attachments?issue_number=${moved.moved_to.number}`,
        { headers: { cookie } },
      );
      expect(listed.status).toBe(200);
      expect(await json(listed)).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});
