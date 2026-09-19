import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActivityEvidenceSource,
  activityLegacyRevisionBoundaryPredicate,
  activityLiveCandidatePredicate,
  activityMembershipPredicate,
} from "../src/services/activity-calendar/membership.ts";

let db: PGlite;
const dialect = new PgDialect();
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
});
afterAll(async () => {
  await db?.close();
});

async function evaluate(predicate: SQL): Promise<boolean> {
  const query = dialect.sqlToQuery(sql`SELECT ${predicate} AS allowed`);
  const result = await db.query<{ allowed: boolean }>(query.sql, query.params);
  return result.rows[0].allowed;
}
const timestamp = (value: string | null) => sql`${value}::timestamptz`;
const sameMicrosecond = "2026-09-01T12:00:00.123456Z";
const issueCreatedAt = "2026-01-01T00:00:00.000001Z";
const manifest = { v: 1, events: 90, comments: 30, revisions: 50 };
const moved = { move_token: "move-one", activity_imported_max_ids: manifest };
const legacy = {
  move_token: "move-old",
  // The target maximum is 30, NOT source maximum 9000 or the last value 20.
  id_map: { comments: { "9000": 30, "9001": 20 } },
};

type Case = {
  source: ActivityEvidenceSource;
  id: number;
  payload?: unknown;
  latestId?: number | null;
  at?: string;
  finishedAt?: string | null;
};
function membership(c: Case): SQL {
  return activityMembershipPredicate({
    source: c.source,
    id: sql`${c.id}::bigint`,
    createdAt: timestamp(c.at ?? sameMicrosecond),
    issueCreatedAt: timestamp(issueCreatedAt),
    latestMovedInId: sql`${c.latestId === undefined ? 100 : c.latestId}::bigint`,
    latestMovedInPayload: sql`${JSON.stringify(c.payload === undefined ? moved : c.payload)}::jsonb`,
    legacyRevisionFinishedAt: timestamp(c.finishedAt ?? null),
  });
}

const cases: [string, Case, boolean][] = [
  [
    "native creation belongs",
    { source: "events", id: 1, latestId: null, at: issueCreatedAt },
    true,
  ],
  [
    "native pre-creation record excluded",
    {
      source: "comments",
      id: 1,
      latestId: null,
      at: "2026-01-01T00:00:00.000000Z",
    },
    false,
  ],
  [
    "native revision needs no move boundary",
    { source: "revisions", id: 1, latestId: null },
    true,
  ],
  ["imported event at same microsecond", { source: "events", id: 90 }, false],
  [
    "moved_in id floor despite lower event watermark",
    { source: "events", id: 99 },
    false,
  ],
  ["boundary event excluded", { source: "events", id: 100 }, false],
  ["new event at same microsecond", { source: "events", id: 101 }, true],
  [
    "imported comment at same microsecond",
    { source: "comments", id: 30 },
    false,
  ],
  ["new comment at same microsecond", { source: "comments", id: 31 }, true],
  [
    "imported revision at same microsecond",
    { source: "revisions", id: 50 },
    false,
  ],
  ["new revision at same microsecond", { source: "revisions", id: 51 }, true],
  [
    "copy timestamp later than planned move remains imported",
    { source: "events", id: 80, at: "2026-09-02T00:00:00.000001Z" },
    false,
  ],
  [
    "higher event watermark wins",
    {
      source: "events",
      id: 110,
      payload: { activity_imported_max_ids: { ...manifest, events: 120 } },
    },
    false,
  ],
  [
    "event after higher watermark",
    {
      source: "events",
      id: 121,
      payload: { activity_imported_max_ids: { ...manifest, events: 120 } },
    },
    true,
  ],
  [
    "null event max still uses recent move id",
    {
      source: "events",
      id: 99,
      payload: { activity_imported_max_ids: { ...manifest, events: null } },
    },
    false,
  ],
  [
    "null event max permits post-move event",
    {
      source: "events",
      id: 101,
      payload: { activity_imported_max_ids: { ...manifest, events: null } },
    },
    true,
  ],
  [
    "null comment max certifies no imports",
    {
      source: "comments",
      id: 1,
      payload: { activity_imported_max_ids: { ...manifest, comments: null } },
    },
    true,
  ],
  [
    "null revision max needs no finished timestamp",
    {
      source: "revisions",
      id: 1,
      payload: { activity_imported_max_ids: { ...manifest, revisions: null } },
    },
    true,
  ],
  [
    "missing source field is not null",
    {
      source: "comments",
      id: 31,
      payload: {
        activity_imported_max_ids: { v: 1, events: null, revisions: null },
      },
    },
    false,
  ],
  [
    "missing sibling source invalidates manifest",
    {
      source: "events",
      id: 101,
      payload: {
        activity_imported_max_ids: { v: 1, events: null, comments: null },
      },
    },
    false,
  ],
  [
    "present null manifest is not legacy",
    { source: "events", id: 101, payload: { activity_imported_max_ids: null } },
    false,
  ],
  [
    "future manifest excluded",
    {
      source: "events",
      id: 101,
      payload: { activity_imported_max_ids: { ...manifest, v: 2 } },
    },
    false,
  ],
  [
    "string max cannot be coerced",
    {
      source: "comments",
      id: 31,
      payload: { activity_imported_max_ids: { ...manifest, comments: "30" } },
    },
    false,
  ],
  [
    "fractional max excluded",
    {
      source: "comments",
      id: 31,
      payload: { activity_imported_max_ids: { ...manifest, comments: 30.5 } },
    },
    false,
  ],
  [
    "negative max excluded",
    {
      source: "comments",
      id: 31,
      payload: { activity_imported_max_ids: { ...manifest, comments: -1 } },
    },
    false,
  ],
  [
    "zero max excluded: empty imports use null",
    {
      source: "comments",
      id: 31,
      payload: { activity_imported_max_ids: { ...manifest, comments: 0 } },
    },
    false,
  ],
  [
    "unsafe max excluded",
    {
      source: "comments",
      id: 31,
      payload: {
        activity_imported_max_ids: { ...manifest, comments: 9007199254740992 },
      },
    },
    false,
  ],
  [
    "nonobject move payload excluded",
    { source: "events", id: 101, payload: [] },
    false,
  ],
  [
    "null move payload excluded",
    { source: "events", id: 101, payload: null },
    false,
  ],
  ["legacy event import", { source: "events", id: 99, payload: legacy }, false],
  [
    "legacy new event same microsecond",
    { source: "events", id: 101, payload: legacy },
    true,
  ],
  [
    "legacy comment target maximum",
    { source: "comments", id: 30, payload: legacy },
    false,
  ],
  [
    "legacy comment after target maximum",
    { source: "comments", id: 31, payload: legacy },
    true,
  ],
  [
    "legacy empty map certifies no imports",
    { source: "comments", id: 1, payload: { id_map: { comments: {} } } },
    true,
  ],
  [
    "legacy absent map excluded",
    { source: "comments", id: 31, payload: {} },
    false,
  ],
  [
    "legacy absent comment map excluded",
    { source: "comments", id: 31, payload: { id_map: {} } },
    false,
  ],
  [
    "legacy null map excluded",
    { source: "comments", id: 31, payload: { id_map: { comments: null } } },
    false,
  ],
  [
    "legacy array map excluded safely",
    { source: "comments", id: 31, payload: { id_map: { comments: [] } } },
    false,
  ],
  [
    "legacy string target excluded safely",
    {
      source: "comments",
      id: 31,
      payload: { id_map: { comments: { "8": "20" } } },
    },
    false,
  ],
  [
    "legacy invalid source key excluded",
    {
      source: "comments",
      id: 31,
      payload: { id_map: { comments: { bad: 20 } } },
    },
    false,
  ],
  [
    "legacy mixed good and bad targets excluded",
    {
      source: "comments",
      id: 31,
      payload: { id_map: { comments: { "8": 20, "9": {} } } },
    },
    false,
  ],
  [
    "legacy revision missing system boundary",
    { source: "revisions", id: 51, payload: legacy },
    false,
  ],
  [
    "legacy revision strictly before done",
    {
      source: "revisions",
      id: 51,
      payload: legacy,
      at: "2026-09-01T12:00:00.123455Z",
      finishedAt: sameMicrosecond,
    },
    false,
  ],
  [
    "legacy revision exactly at done excluded",
    {
      source: "revisions",
      id: 51,
      payload: legacy,
      finishedAt: sameMicrosecond,
    },
    false,
  ],
  [
    "legacy revision one microsecond after done",
    {
      source: "revisions",
      id: 51,
      payload: legacy,
      at: "2026-09-01T12:00:00.123457Z",
      finishedAt: sameMicrosecond,
    },
    true,
  ],
  [
    "latest move replaces earlier segment",
    { source: "events", id: 101, latestId: 200 },
    false,
  ],
  ["new latest segment", { source: "events", id: 201, latestId: 200 }, true],
];

describe("activity membership SQL", () => {
  it.each(cases)("%s", async (_name, fixture, expected) => {
    expect(await evaluate(membership(fixture))).toBe(expected);
  });

  it.each([
    [null, null, true],
    [sameMicrosecond, null, false],
    [null, sameMicrosecond, false],
    [sameMicrosecond, sameMicrosecond, false],
  ] as const)(
    "live with deleted_at=%s moved_at=%s",
    async (deletedAt, movedAt, expected) => {
      expect(
        await evaluate(
          activityLiveCandidatePredicate({
            deletedAt: timestamp(deletedAt),
            movedAt: timestamp(movedAt),
          }),
        ),
      ).toBe(expected);
    },
  );

  it.each([
    [
      '{"activity_imported_max_ids":{"v":1,"events":90,"comments":30.0,"revisions":50}}',
      30,
      false,
    ],
    [
      '{"activity_imported_max_ids":{"v":1,"events":90,"comments":30.0,"revisions":50}}',
      31,
      true,
    ],
    ['{"id_map":{"comments":{"9000":30.0}}}', 30, false],
    ['{"id_map":{"comments":{"9000":30.0}}}', 31, true],
  ] as const)(
    "accepts integral JSON numeric scale: %s at %s",
    async (rawPayload, id, expected) => {
      // Preserve the JSON numeric scale; JSON.stringify(30.0) would erase it.
      expect(
        await evaluate(
          activityMembershipPredicate({
            source: "comments",
            id: sql`${id}::bigint`,
            createdAt: timestamp(sameMicrosecond),
            issueCreatedAt: timestamp(issueCreatedAt),
            latestMovedInId: sql`100::bigint`,
            latestMovedInPayload: sql`${rawPayload}::jsonb`,
            legacyRevisionFinishedAt: sql`NULL::timestamptz`,
          }),
        ),
      ).toBe(expected);
    },
  );

  it.each([
    ["move-old", 2, 7, "done", sameMicrosecond, true],
    ["other-move", 2, 7, "done", sameMicrosecond, false],
    ["move-old", 3, 7, "done", sameMicrosecond, false],
    ["move-old", 2, 8, "done", sameMicrosecond, false],
    ["move-old", 2, 7, "copying", sameMicrosecond, false],
    ["move-old", 2, 7, "copied", sameMicrosecond, false],
    ["move-old", 2, 7, "done", null, false],
  ] as const)(
    "verifies legacy record %s/%s/%s/%s/%s",
    async (token, project, number, state, finished, expected) => {
      expect(
        await evaluate(
          activityLegacyRevisionBoundaryPredicate(
            {
              moveToken: sql`${token}::text`,
              toProjectId: sql`${project}::bigint`,
              toNumber: sql`${number}::bigint`,
              state: sql`${state}::text`,
              finishedAt: timestamp(finished),
            },
            { moveToken: sql`'move-old'`, projectId: sql`2`, number: sql`7` },
          ),
        ),
      ).toBe(expected);
    },
  );

  it("uses the greatest moved_in id even when timestamps run backwards", async () => {
    const predicate = activityMembershipPredicate({
      source: "events",
      id: sql`candidate.id`,
      createdAt: sql`candidate.created_at`,
      issueCreatedAt: timestamp(issueCreatedAt),
      latestMovedInId: sql`latest.id`,
      latestMovedInPayload: sql`latest.payload`,
      legacyRevisionFinishedAt: sql`NULL::timestamptz`,
    });
    const query = dialect.sqlToQuery(sql`
      WITH moves(id, created_at, payload) AS (VALUES
        (100, '2026-09-02T00:00:00Z'::timestamptz, '{}'::jsonb),
        (200, '2026-09-01T00:00:00Z'::timestamptz, '{}'::jsonb)
      ), latest AS (SELECT * FROM moves ORDER BY id DESC LIMIT 1),
      candidate(id, created_at) AS (VALUES
        (150, '2026-09-03T00:00:00Z'::timestamptz),
        (201, '2026-09-01T00:00:00Z'::timestamptz)
      )
      SELECT candidate.id FROM candidate CROSS JOIN latest
      WHERE ${predicate} ORDER BY candidate.id
    `);
    const result = await db.query<{ id: number }>(query.sql, query.params);
    expect(result.rows.map((row) => row.id)).toEqual([201]);
  });
});
