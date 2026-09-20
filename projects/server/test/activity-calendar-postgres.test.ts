import { randomUUID } from "node:crypto";
import type {
  ActivityCalendarQuery,
  ActivityCalendarResponse,
} from "@todou/shared";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import type { Db } from "../src/db/driver.ts";
import {
  comments,
  issueEvents,
  issues,
  revisions,
  statuses,
} from "../src/db/project-schema.ts";
import { issueMoves, projects, users } from "../src/db/system-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { buildActivityBuckets } from "../src/services/activity-calendar/buckets.ts";
import {
  getProjectActivityCalendar,
  getUserActivityCalendar,
} from "../src/services/activity-calendar/index.ts";
import { rowsFrom } from "../src/services/calendar.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type PlacementMode,
  type TestApp,
} from "./helpers.ts";

/**
 * Opt in with TODOU_TEST_POSTGRES_URL. The supplied database is used only as
 * the administrative connection: all migrated tables live in disposable,
 * uniquely named databases. The role needs CREATEDB and migration privileges
 * (including pg_trgm). Never print the URL or include it in assertion values.
 *
 * Dedicated placement MUST override urlTemplate: systemUrl alone leaves the
 * project tier on PGlite. All three cases below use the node-postgres driver.
 * No additional environment gate, fallback driver, or skipped test is allowed.
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const BORN = "2010-01-01T00:00:00.000000Z";
const NOW = "2026-09-19T00:00:00.123Z";
const dialect = new PgDialect();
const timestamp = (at: string) => sql`${at}::timestamptz`;
type ProjectFixture = {
  row: typeof projects.$inferSelect;
  db: Db;
  statusId: number;
  nextNumber: number;
};
type CardFixture = { id: number; number: number; title: string };
type PostgresStorage = {
  systemUrl: string;
  urlTemplate: string | undefined;
  slugs: string[];
  cleanup: () => Promise<void>;
};

// Only generated identifiers enter CREATE/DROP DATABASE; connection strings
// stay in memory. Remember ownership only after CREATE succeeds.
async function provision(placement: PlacementMode): Promise<PostgresStorage> {
  if (!PG_URL || !/^postgres(?:ql)?:\/\//.test(PG_URL)) {
    throw new Error("TODOU_TEST_POSTGRES_URL must select real PostgreSQL");
  }
  const tag = `t422_${randomUUID().replaceAll("-", "")}`;
  const slugs = [0, 1, 2].map((n) => `${tag.replaceAll("_", "")}p${n}`);
  const owned: string[] = [];
  const admin = new pg.Client({ connectionString: PG_URL });
  const urlFor = (name: string) => {
    const url = new URL(PG_URL);
    url.pathname = `/${name}`;
    // pg connection strings may specify dbname separately from pathname.
    url.searchParams.delete("database");
    url.searchParams.delete("dbname");
    return url.toString();
  };
  const cleanup = async () => {
    let failed = false;
    try {
      for (const name of [...owned].reverse()) {
        try {
          await admin.query(`DROP DATABASE "${name}"`);
          owned.splice(owned.indexOf(name), 1);
        } catch {
          failed = true;
        }
      }
    } finally {
      await admin.end();
    }
    if (failed)
      throw new Error("activity calendar disposable database cleanup failed");
  };
  try {
    await admin.connect();
    const names = [
      `${tag}_system`,
      ...(placement === "dedicated"
        ? slugs
        : placement === "dedicated-bucketed"
          ? [`${tag}_b0`, `${tag}_b1`]
          : []),
    ];
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}"`);
      owned.push(name);
    }
    const template =
      placement === "dedicated"
        ? urlFor("CALENDAR_TARGET").replace(
            "CALENDAR_TARGET",
            "${project.slug}",
          )
        : urlFor("CALENDAR_TARGET").replace(
            "CALENDAR_TARGET",
            `${tag}_b\${project.id % 2}`,
          );
    return {
      systemUrl: urlFor(`${tag}_system`),
      urlTemplate: placement === "shared" ? undefined : template,
      slugs,
      cleanup,
    };
  } catch {
    await cleanup();
    throw new Error(
      "activity calendar PostgreSQL setup failed; role needs CREATEDB and access to disposable databases",
    );
  }
}

function countOn(response: ActivityCalendarResponse, date: string) {
  return response.days.find((day) => day.date === date);
}

for (const placement of PLACEMENTS) {
  describe.skipIf(!PG_URL)(
    `activity calendar on real postgres (${placement})`,
    () => {
      let storage: PostgresStorage | undefined;
      let t: TestApp | undefined;
      let viewer: UserRow;
      const fixtures: ProjectFixture[] = [];

      beforeAll(async () => {
        storage = await provision(placement);
        try {
          t = await makeTestApp(placement, storage);
          const identity = await addUserWithToken(t.ctx, "calendar-user", {
            instanceAdmin: true,
          });
          viewer = identity.user;
          await t.ctx.router
            .system()
            .update(users)
            .set({ createdAt: timestamp(BORN) })
            .where(eq(users.id, viewer.id));
          for (const slug of storage.slugs) {
            const response = await t.app.request("/api/projects", {
              method: "POST",
              headers: {
                ...identity.headers,
                "content-type": "application/json",
              },
              body: JSON.stringify({ slug, name: slug }),
            });
            expect(response.status).toBe(201);
            const { id } = (await response.json()) as { id: number };
            const [row] = await t.ctx.router
              .system()
              .update(projects)
              .set({ createdAt: timestamp(BORN) })
              .where(eq(projects.id, id))
              .returning();
            if (!row) throw new Error("missing calendar project fixture");
            const db = await t.ctx.router.forProject(routeInfoOf(row));
            const [status] = await db
              .select()
              .from(statuses)
              .where(eq(statuses.projectId, id));
            if (!status) throw new Error("missing calendar status fixture");
            fixtures.push({ row, db, statusId: status.id, nextNumber: 1 });
          }
        } catch {
          await t?.cleanup();
          t = undefined;
          const failedStorage = storage;
          storage = undefined;
          await failedStorage.cleanup();
          throw new Error(
            "activity calendar fixture setup failed; check PostgreSQL migration privileges",
          );
        }
      }, 120_000);

      afterAll(async () => {
        try {
          await t?.cleanup();
        } finally {
          await storage?.cleanup();
        }
      }, 60_000);

      async function card(
        p: ProjectFixture,
        title: string,
        born = BORN,
      ): Promise<CardFixture> {
        const [row] = await p.db
          .insert(issues)
          .values({
            projectId: p.row.id,
            number: p.nextNumber++,
            title,
            statusId: p.statusId,
            authorId: viewer.id,
            createdAt: timestamp(born),
          })
          .returning({
            id: issues.id,
            number: issues.number,
            title: issues.title,
          });
        if (!row) throw new Error("missing calendar card fixture");
        return row;
      }

      async function evidence(
        p: ProjectFixture,
        c: CardFixture,
        at: string,
        source: "events" | "comments" | "revisions" = "comments",
      ): Promise<number> {
        const row =
          source === "events"
            ? (
                await p.db
                  .insert(issueEvents)
                  .values({
                    projectId: p.row.id,
                    issueId: c.id,
                    actorId: viewer.id,
                    type: "title_changed",
                    payload: { from: "old", to: "new" },
                    createdAt: timestamp(at),
                  })
                  .returning({ id: issueEvents.id })
              )[0]
            : source === "comments"
              ? (
                  await p.db
                    .insert(comments)
                    .values({
                      projectId: p.row.id,
                      issueId: c.id,
                      authorId: viewer.id,
                      body: "calendar evidence",
                      createdAt: timestamp(at),
                    })
                    .returning({ id: comments.id })
                )[0]
              : (
                  await p.db
                    .insert(revisions)
                    .values({
                      projectId: p.row.id,
                      subjectType: "issue_body",
                      subjectId: c.id,
                      actorId: viewer.id,
                      body: "previous body",
                      createdAt: timestamp(at),
                    })
                    .returning({ id: revisions.id })
                )[0];
        if (!row) throw new Error("missing calendar evidence fixture");
        return row.id;
      }

      async function calendar(
        p: ProjectFixture | "user",
        day: string,
        extra: Partial<ActivityCalendarQuery> = {},
      ) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(NOW));
        try {
          const year = Number(day.slice(0, 4));
          const query = {
            from: `${year}-01-01`,
            to: `${year + 1}-01-01`,
            tz: "UTC",
            day,
            limit: 100,
            ...extra,
          };
          return await (p === "user"
            ? getUserActivityCalendar(t!.ctx, viewer, String(viewer.id), query)
            : getProjectActivityCalendar(t!.ctx, viewer, p.row.slug, query));
        } finally {
          vi.useRealTimers();
        }
      }

      it("uses real Postgres for system and project tiers with the intended placement", async () => {
        expect(t!.ctx.router.systemHandle().kind).toBe("postgres");
        const databases: string[] = [];
        for (const p of fixtures) {
          const [row] = rowsFrom(
            await p.db.execute(
              sql`select current_database() as name, version() as version`,
            ),
          );
          expect(String(row?.version)).toContain("PostgreSQL");
          expect(String(row?.version)).not.toContain("PGlite");
          databases.push(String(row?.name));
        }
        const [system] = rowsFrom(
          await t!.ctx.router
            .system()
            .execute(sql`select current_database() as name`),
        );
        expect(new Set(databases).size).toBe(
          placement === "shared" ? 1 : placement === "dedicated" ? 3 : 2,
        );
        expect(databases.includes(String(system?.name))).toBe(
          placement === "shared",
        );
        if (placement === "dedicated-bucketed") {
          expect(databases[0]).toBe(databases[2]);
          expect(databases[0]).not.toBe(databases[1]);
        }
      });

      it("orders microsecond neighbors and exact ties across projects and drains every cursor once", async () => {
        const day = "2025-09-01";
        const expected: Array<{ project: number; issue: number; at: string }> =
          [];
        for (const p of fixtures) {
          for (const suffix of ["123456", "123457", "123456"]) {
            const c = await card(p, `precision ${suffix}`);
            const at = `${day}T12:00:00.${suffix}Z`;
            await evidence(p, c, at);
            // Several evidence sources still count one card/day; MAX keeps µs.
            await evidence(p, c, `${day}T12:00:00.123455Z`, "events");
            expected.push({ project: p.row.id, issue: c.id, at });
          }
        }
        expected.sort((a, b) =>
          a.at === b.at
            ? a.project - b.project || a.issue - b.issue
            : a.at > b.at
              ? -1
              : 1,
        );
        const actual: typeof expected = [];
        let after: string | undefined;
        for (let page = 0; page < expected.length; page++) {
          const response = await calendar("user", day, { limit: 2, after });
          expect(countOn(response, day)).toEqual({
            date: day,
            state: "recorded",
            count: expected.length,
          });
          expect(response.selection?.total).toBe(expected.length);
          const selection = response.selection!;
          actual.push(
            ...selection.items.map((item) => ({
              project: item.project.id,
              issue: item.issue_id,
              at: item.last_active_at,
            })),
          );
          expect(selection.has_more).toBe(selection.next_cursor !== null);
          if (!selection.has_more) break;
          expect(selection.next_cursor).not.toBe(after);
          after = selection.next_cursor!;
        }
        expect(actual).toEqual(expected);
        expect(
          new Set(actual.map((row) => `${row.project}/${row.issue}`)).size,
        ).toBe(expected.length);
      });

      it("keeps midnight and request cutoff half-open at one-microsecond precision", async () => {
        const p = fixtures[0]!;
        const before = await card(p, "one microsecond before midnight");
        const midnight = await card(p, "midnight");
        const cutoffBefore = await card(p, "one microsecond before cutoff");
        const cutoffEqual = await card(p, "exact cutoff");
        const cutoffAfter = await card(p, "one microsecond after cutoff");
        await evidence(p, before, "2026-09-18T23:59:59.999999Z");
        await evidence(p, midnight, "2026-09-19T00:00:00.000000Z");
        await evidence(p, cutoffBefore, "2026-09-19T00:00:00.122999Z");
        await evidence(p, cutoffEqual, "2026-09-19T00:00:00.123000Z");
        await evidence(p, cutoffAfter, "2026-09-19T00:00:00.123001Z");
        const previous = await calendar(p, "2026-09-18");
        expect(previous.selection?.items.map((c) => c.issue_id)).toEqual([
          before.id,
        ]);
        const current = await calendar(p, "2026-09-19");
        expect(current.cutoff).toBe(NOW);
        expect(
          current.selection?.items.map((c) => [c.issue_id, c.last_active_at]),
        ).toEqual([
          [cutoffBefore.id, "2026-09-19T00:00:00.122999Z"],
          [midnight.id, "2026-09-19T00:00:00.000000Z"],
        ]);
        expect(countOn(current, "2026-09-18")?.count).toBe(1);
        expect(countOn(current, "2026-09-19")?.count).toBe(2);
        expect(countOn(current, "2026-09-20")).toEqual({
          date: "2026-09-20",
          state: "future",
          count: null,
        });
      });

      it.each([
        {
          day: "2025-03-09",
          tz: "America/New_York",
          hours: 23,
          start: "2025-03-09T05:00:00.000000Z",
          end: "2025-03-10T04:00:00.000000Z",
          before: "2025-03-09T04:59:59.999999Z",
          last: "2025-03-10T03:59:59.999999Z",
          inside: [
            "2025-03-09T06:59:59.999999Z",
            "2025-03-09T07:00:00.000000Z",
          ],
        },
        {
          day: "2025-11-02",
          tz: "America/New_York",
          hours: 25,
          start: "2025-11-02T04:00:00.000000Z",
          end: "2025-11-03T05:00:00.000000Z",
          before: "2025-11-02T03:59:59.999999Z",
          last: "2025-11-03T04:59:59.999999Z",
          inside: [
            "2025-11-02T05:30:00.000001Z",
            "2025-11-02T06:30:00.000001Z",
          ],
        },
        {
          day: "2011-12-29",
          tz: "Pacific/Apia",
          hours: 24,
          start: "2011-12-29T10:00:00.000000Z",
          end: "2011-12-30T10:00:00.000000Z",
          before: "2011-12-29T09:59:59.999999Z",
          last: "2011-12-30T09:59:59.999999Z",
          inside: [],
        },
      ])("uses IANA boundaries for $tz on $day", async (boundary) => {
        const p = fixtures[0]!;
        const included: number[] = [];
        for (const at of [
          boundary.before,
          boundary.start,
          ...boundary.inside,
          boundary.last,
          boundary.end,
        ]) {
          const c = await card(p, `boundary ${at}`);
          await evidence(p, c, at);
          if (at !== boundary.before && at !== boundary.end)
            included.push(c.id);
        }
        const year = Number(boundary.day.slice(0, 4));
        const plan = await buildActivityBuckets(t!.ctx.router.system(), {
          fromDate: `${year}-01-01`,
          toDate: `${year + 1}-01-01`,
          timezone: boundary.tz,
          cutoff: NOW,
          bornAt: BORN,
        });
        expect(
          plan.buckets.find((bucket) => bucket.date === boundary.day),
        ).toEqual({
          date: boundary.day,
          start: boundary.start,
          end: boundary.end,
          state: "recorded",
        });
        expect(
          (Date.parse(boundary.end) - Date.parse(boundary.start)) / 3_600_000,
        ).toBe(boundary.hours);
        const response = await calendar(p, boundary.day, { tz: boundary.tz });
        expect(response.selection?.items.map((c) => c.issue_id)).toEqual(
          included.reverse(),
        );
        expect(countOn(response, boundary.day)?.count).toBe(included.length);
        if (boundary.tz === "Pacific/Apia") {
          expect(countOn(response, "2011-12-30")).toEqual({
            date: "2011-12-30",
            state: "not_applicable",
            count: null,
          });
          expect(countOn(response, "2011-12-31")?.count).toBe(1);
          await expect(
            calendar(p, "2011-12-30", { tz: boundary.tz }),
          ).rejects.toThrow("day must be an applicable");
          const next = await calendar(p, "2011-12-31", { tz: boundary.tz });
          expect(next.selection?.items[0]?.last_active_at).toBe(boundary.end);
        }
      });

      it("uses imported ID watermarks for all sources even at the identical microsecond", async () => {
        const p = fixtures[1]!;
        const day = "2025-07-01";
        const at = `${day}T12:00:00.123456Z`;
        const expected: number[] = [];
        for (const source of ["events", "comments", "revisions"] as const) {
          const c = await card(p, `watermark ${source}`);
          const imported = await evidence(p, c, at, source);
          const [move] = await p.db
            .insert(issueEvents)
            .values({
              projectId: p.row.id,
              issueId: c.id,
              actorId: viewer.id,
              type: "moved_in",
              createdAt: timestamp(at),
              payload: {
                move_token: randomUUID(),
                activity_imported_max_ids: {
                  v: 1,
                  events: null,
                  comments: null,
                  revisions: null,
                  [source]: imported,
                },
              },
            })
            .returning({ id: issueEvents.id });
          expect(move).toBeDefined();
          expect(
            (await calendar(p, day)).selection?.items
              .map((item) => item.issue_id)
              .sort((a, b) => a - b),
          ).toEqual(expected);
          const fresh = await evidence(p, c, at, source);
          expect(fresh).toBeGreaterThan(
            source === "events" ? move!.id : imported,
          );
          expected.push(c.id);
          const response = await calendar(p, day);
          expect(
            response.selection?.items
              .map((item) => item.issue_id)
              .sort((a, b) => a - b),
          ).toEqual(expected);
          expect(
            response.selection?.items.every(
              (item) => item.last_active_at === at,
            ),
          ).toBe(true);
          expect(countOn(response, day)?.count).toBe(expected.length);
        }
      });

      it("uses legacy event/comment IDs and a strictly later verified revision finished_at", async () => {
        const p = fixtures[1]!;
        const day = "2025-07-02";
        const at = `${day}T12:00:00.123456Z`;
        const expected: number[] = [];
        for (const source of ["events", "comments", "revisions"] as const) {
          const c = await card(p, `legacy ${source}`);
          const imported = await evidence(p, c, at, source);
          const token = randomUUID();
          await p.db.insert(issueEvents).values({
            projectId: p.row.id,
            issueId: c.id,
            actorId: viewer.id,
            type: "moved_in",
            createdAt: timestamp(at),
            payload: {
              move_token: token,
              id_map: {
                comments: source === "comments" ? { "900000": imported } : {},
              },
            },
          });
          await t!.ctx.router
            .system()
            .insert(issueMoves)
            .values({
              moveToken: token,
              fromProjectId: fixtures[0]!.row.id,
              fromNumber: c.number,
              toProjectId: p.row.id,
              toNumber: c.number,
              actorId: viewer.id,
              movedAt: timestamp(at),
              finishedAt: timestamp(at),
              state: "done",
            });
          if (source === "revisions") {
            await evidence(p, c, `${day}T12:00:00.123455Z`, source);
            await evidence(p, c, at, source);
          }
          expect((await calendar(p, day)).selection?.total).toBe(
            expected.length,
          );
          await evidence(
            p,
            c,
            source === "revisions" ? `${day}T12:00:00.123457Z` : at,
            source,
          );
          expected.push(c.id);
          const response = await calendar(p, day);
          expect(
            response.selection?.items
              .map((item) => item.issue_id)
              .sort((a, b) => a - b),
          ).toEqual(expected);
          expect(
            response.selection?.items.find((item) => item.issue_id === c.id)
              ?.last_active_at,
          ).toBe(source === "revisions" ? `${day}T12:00:00.123457Z` : at);
        }
      });

      it.each(["missing", "wrong destination", "unfinished"] as const)(
        "excludes legacy revisions with a %s system boundary",
        async (kind) => {
          const p = fixtures[1]!;
          const day = "2025-07-03";
          const c = await card(p, `legacy ${kind}`);
          const token = randomUUID();
          await evidence(p, c, `${day}T12:00:00.123457Z`, "revisions");
          await p.db.insert(issueEvents).values({
            projectId: p.row.id,
            issueId: c.id,
            actorId: viewer.id,
            type: "moved_in",
            payload: { move_token: token, id_map: { comments: {} } },
            createdAt: timestamp(`${day}T12:00:00.123456Z`),
          });
          if (kind !== "missing") {
            await t!.ctx.router
              .system()
              .insert(issueMoves)
              .values({
                moveToken: token,
                fromProjectId: fixtures[0]!.row.id,
                fromNumber: c.number,
                toProjectId: p.row.id,
                toNumber:
                  kind === "wrong destination" ? c.number + 1000 : c.number,
                actorId: viewer.id,
                movedAt: timestamp(`${day}T12:00:00.123456Z`),
                finishedAt: timestamp(`${day}T12:00:00.123456Z`),
                state: kind === "unfinished" ? "copied" : "done",
              });
          }
          const response = await calendar(p, day);
          expect(response.selection?.items).toEqual([]);
          expect(countOn(response, day)?.count).toBe(0);
        },
      );

      it.each([
        ["delete issue", "2025-08-01"],
        ["delete comment", "2025-08-02"],
        ["title", "2025-08-03"],
        ["update evidence", "2025-08-04"],
        ["insert evidence", "2025-08-05"],
      ] as const)(
        "keeps counts and selected cards in one snapshot after %s",
        async (mutation, day) => {
          const p = fixtures[2]!;
          const target = await card(p, "title before count");
          const anchor = await card(p, "unchanged anchor");
          const inserted = await card(p, "newly active after count");
          const oldAt = `${day}T12:00:00.123456Z`;
          const newAt = `${day}T12:00:00.123457Z`;
          const commentId = await evidence(p, target, oldAt);
          await evidence(p, anchor, `${day}T12:00:00.123455Z`);
          const baseline = await calendar(p, day);
          expect(baseline.selection?.total).toBe(2);

          // Barrier contract: execute the REAL count first, then await a COMMIT on
          // an independent connection before allowing selection/hydration to run.
          // No sleep, mocked query result, same-connection write, or production hook.
          const writer = new pg.Client({
            connectionString: t!.ctx.router.resolveProjectUrl(
              routeInfoOf(p.row),
            ),
          });
          const transaction = p.db.transaction.bind(p.db);
          let countHits = 0;
          let selectionAfterCommit = false;
          let committed = false;
          let writerPid = 0;
          const barrier = vi
            .spyOn(p.db, "transaction")
            .mockImplementation((callback, config) =>
              transaction(async (tx) => {
                const execute = tx.execute.bind(tx);
                const intercept = vi
                  .spyOn(tx, "execute")
                  .mockImplementation((async (
                    query: Parameters<typeof tx.execute>[0],
                  ) => {
                    const text =
                      typeof query === "string"
                        ? query
                        : dialect.sqlToQuery(query.getSQL()).sql;
                    const result = await execute(query);
                    if (
                      /select date, count\(\*\) as count from activity_card_days/.test(
                        text,
                      )
                    ) {
                      countHits++;
                      expect(countHits).toBe(1);
                      const [snapshot] = rowsFrom(
                        await execute(sql`
              select current_setting('transaction_isolation') as isolation,
                current_setting('transaction_read_only') as read_only, pg_backend_pid() as pid
            `),
                      );
                      expect(snapshot?.isolation).toBe("repeatable read");
                      expect(snapshot?.read_only).toBe("on");
                      expect(Number(snapshot?.pid)).not.toBe(writerPid);
                      await writer.query("BEGIN");
                      try {
                        if (mutation === "delete issue") {
                          await writer.query(
                            "UPDATE issues SET deleted_at = $1::timestamptz WHERE id = $2 AND project_id = $3",
                            [newAt, target.id, p.row.id],
                          );
                        } else if (mutation === "delete comment") {
                          await writer.query(
                            "DELETE FROM comments WHERE id = $1 AND project_id = $2",
                            [commentId, p.row.id],
                          );
                        } else if (mutation === "title") {
                          await writer.query(
                            "UPDATE issues SET title = $1 WHERE id = $2 AND project_id = $3",
                            ["title after count", target.id, p.row.id],
                          );
                        } else if (mutation === "update evidence") {
                          await writer.query(
                            "UPDATE comments SET created_at = $1::timestamptz WHERE id = $2 AND project_id = $3",
                            [newAt, commentId, p.row.id],
                          );
                        } else {
                          await writer.query(
                            "INSERT INTO comments (project_id, issue_id, author_id, body, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)",
                            [
                              p.row.id,
                              inserted.id,
                              viewer.id,
                              "inserted after count",
                              newAt,
                            ],
                          );
                        }
                        await writer.query("COMMIT");
                        committed = true;
                      } catch (error) {
                        await writer.query("ROLLBACK");
                        throw error;
                      }
                    }
                    if (/select d\.issue_id, i\.number, i\.title/.test(text)) {
                      expect(committed).toBe(true);
                      selectionAfterCommit = true;
                    }
                    return result;
                  }) as typeof tx.execute);
                try {
                  return await callback(tx);
                } finally {
                  intercept.mockRestore();
                }
              }, config),
            );
          try {
            await writer.connect();
            writerPid = Number(
              (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0]
                .pid,
            );
            const during = await calendar(p, day);
            expect(countHits).toBe(1);
            expect(selectionAfterCommit).toBe(true);
            expect(during.days).toEqual(baseline.days);
            expect(during.selection).toEqual(baseline.selection);
          } finally {
            barrier.mockRestore();
            await writer.end();
          }
          // A fresh request must observe the committed change. This prevents a
          // broken writer/barrier from making snapshot assertions pass vacuously.
          const after = await calendar(p, day);
          const selected = after.selection!;
          if (mutation === "delete issue" || mutation === "delete comment") {
            expect(selected.total).toBe(1);
            expect(selected.items.map((item) => item.issue_id)).toEqual([
              anchor.id,
            ]);
          } else if (mutation === "title") {
            expect(selected.total).toBe(2);
            expect(
              selected.items.find((item) => item.issue_id === target.id)?.title,
            ).toBe("title after count");
          } else if (mutation === "update evidence") {
            expect(selected.total).toBe(2);
            expect(
              selected.items.find((item) => item.issue_id === target.id)
                ?.last_active_at,
            ).toBe(newAt);
          } else {
            expect(selected.total).toBe(3);
            expect(selected.items[0]?.issue_id).toBe(inserted.id);
          }
          expect(countOn(after, day)?.count).toBe(selected.total);
          expect(selected).not.toEqual(baseline.selection);
        },
      );

      it("applies the native issue birth boundary without rounding microseconds", async () => {
        const p = fixtures[0]!;
        const day = "2025-06-01";
        const born = `${day}T12:00:00.123456Z`;
        const before = await card(p, "before native birth", born);
        const equal = await card(p, "at native birth", born);
        const after = await card(p, "after native birth", born);
        await evidence(p, before, `${day}T12:00:00.123455Z`);
        await evidence(p, equal, born);
        await evidence(p, after, `${day}T12:00:00.123457Z`);
        const response = await calendar(p, day);
        expect(response.selection?.items.map((item) => item.issue_id)).toEqual([
          after.id,
          equal.id,
        ]);
        expect(countOn(response, day)?.count).toBe(2);
      });

      it.each(["once", "twice"] as const)(
        "rechecks a move token changed %s between prefetch and snapshot",
        async (changes) => {
          const p = fixtures[1]!;
          const day = changes === "once" ? "2025-07-04" : "2025-07-05";
          const c = await card(p, "move changes after system prefetch");
          const evidenceAt = `${day}T12:00:00.123457Z`;
          await evidence(p, c, evidenceAt, "revisions");
          async function moveBoundary(finishedAt: string) {
            const token = randomUUID();
            await p.db.insert(issueEvents).values({
              projectId: p.row.id,
              issueId: c.id,
              actorId: viewer.id,
              type: "moved_in",
              createdAt: timestamp(`${day}T12:00:00.123456Z`),
              payload: { move_token: token, id_map: { comments: {} } },
            });
            await t!.ctx.router
              .system()
              .insert(issueMoves)
              .values({
                moveToken: token,
                fromProjectId: fixtures[0]!.row.id,
                fromNumber: c.number,
                toProjectId: p.row.id,
                toNumber: c.number,
                actorId: viewer.id,
                state: "done",
                movedAt: timestamp(`${day}T12:00:00.123456Z`),
                finishedAt: timestamp(finishedAt),
              });
          }
          await moveBoundary(`${day}T12:00:00.123456Z`);
          expect((await calendar(p, day)).selection?.total).toBe(1);
          const transaction = p.db.transaction.bind(p.db);
          let attempts = 0;
          // projectSnapshot has read moveHeads and prefetched system boundaries
          // when it calls transaction. Commit the new head before BEGIN so the
          // in-snapshot head check must detect the stale prefetched token.
          const race = vi
            .spyOn(p.db, "transaction")
            .mockImplementation(async (callback, config) => {
              attempts++;
              if (attempts === 1 || changes === "twice")
                await moveBoundary(evidenceAt);
              return transaction(callback, config);
            });
          try {
            if (changes === "twice") {
              await expect(calendar(p, day)).rejects.toThrow(
                "activity changed; restart the calendar",
              );
            } else {
              const response = await calendar(p, day);
              expect(response.selection?.items).toEqual([]);
              expect(countOn(response, day)?.count).toBe(0);
            }
            expect(attempts).toBe(2);
          } finally {
            race.mockRestore();
          }
        },
      );
    },
  );
}
