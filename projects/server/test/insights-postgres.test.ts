import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { BurnResponse, Project, Settings } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, authMiddleware } from "../src/auth/middleware.ts";
import {
  insightsSettings,
  issueEvents,
  issues,
  projectMeta,
  statuses,
} from "../src/db/project-schema.ts";
import { registerErrorHandler } from "../src/error-handler.ts";
import { insightsRoutes } from "../src/routes/insights.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const json = (response: Response): Promise<unknown> => response.json();

// MVCC acceptance requires running this suite against real PostgreSQL with
// zero skipped tests; the optional local-dev skip is not evidence of a pass.
describe.skipIf(!PG_URL)("insights on PostgreSQL", () => {
  let t: TestApp;
  let cookie: string;
  const slug = `insights-pg-${Date.now().toString(36)}`;

  beforeAll(async () => {
    if (!PG_URL || !/^postgres(?:ql)?:\/\//.test(PG_URL)) {
      throw new Error(
        "insights-postgres requires TODOU_TEST_POSTGRES_URL pointing to real PostgreSQL",
      );
    }
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const response = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(response.status).toBe(201);
  });

  afterAll(async () => t?.cleanup());

  async function fixture() {
    const projectSlug = `insights-pg-${randomUUID()}`;
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug: projectSlug, name: projectSlug }),
    });
    expect(created.status).toBe(201);
    const project = Project.parse(await json(created));
    const settingsResponse = await t.app.request(
      `/api/projects/${projectSlug}/insights/settings`,
      { headers: { cookie } },
    );
    expect(settingsResponse.status).toBe(200);
    const settings = Settings.parse(await json(settingsResponse));
    const todo = settings.roles.find((status) => status.name === "Todo");
    const done = settings.roles.find((status) => status.name === "Done");
    const shipped = settings.roles.find((status) => status.name === "Shipped");
    if (!todo || !done || !shipped) throw new Error("seeded statuses missing");
    const card = await t.app.request(`/api/projects/${projectSlug}/issues`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: "snapshot fixture",
        status_id: todo.status_id,
      }),
    });
    expect(card.status).toBe(201);
    const db = t.ctx.router.system();
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.projectId, project.id));
    if (!issue) throw new Error("fixture issue missing");
    const createdAt = new Date("2026-01-01T12:00:00Z");
    await db.transaction(async (tx) => {
      await tx
        .update(projectMeta)
        .set({ createdAt: new Date("2025-12-31T00:00:00Z") })
        .where(eq(projectMeta.projectId, project.id));
      await tx.update(issues).set({ createdAt }).where(eq(issues.id, issue.id));
      await tx
        .update(issueEvents)
        .set({ createdAt })
        .where(eq(issueEvents.issueId, issue.id));
    });
    const query = new URLSearchParams({
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-04T00:00:00Z",
      grain: "1d",
      tz: "UTC",
    });
    return {
      project,
      issue,
      settings,
      todo,
      done,
      shipped,
      db,
      path: `/api/projects/${projectSlug}/insights/burn`,
      query,
    };
  }

  async function burn(path: string, query: URLSearchParams) {
    const response = await t.app.request(`${path}?${query}`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return BurnResponse.parse(await json(response));
  }

  it("keeps the first-read snapshot after another PostgreSQL connection commits", async () => {
    const f = await fixture();
    const before = await burn(f.path, f.query);
    expect(before.cohort.count).toBe(1);
    expect(
      before.buckets.map((bucket) => bucket.stock?.remaining.value),
    ).toEqual([1, 1, 1]);
    expect(before.buckets[1]?.flow?.completed.value).toBe(0);

    // A dedicated Client cannot reuse the reader's checked-out pool connection.
    // Its transaction must finish COMMIT before afterFirstRead returns; there
    // are no sleeps or scheduler races, and a failed writer rejects the read.
    const client = new pg.Client({
      connectionString: PG_URL,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      statement_timeout: 5_000,
    });
    let hookCalls = 0;
    try {
      await client.connect();
      const writer = drizzle(client);
      const app = new OpenAPIHono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("appCtx", t.ctx);
        await next();
      });
      app.use("*", authMiddleware(t.ctx));
      // Mount the production route, including query validation, service replay,
      // aggregation and JSON serialization. Only this router owns the hook.
      app.route(
        "/api/projects",
        insightsRoutes({
          afterFirstRead: async () => {
            hookCalls += 1;
            await writer.transaction(async (tx) => {
              await tx
                .update(statuses)
                .set({ color: "#123456" })
                .where(eq(statuses.id, f.todo.status_id));
              await tx.insert(insightsSettings).values({
                projectId: f.project.id,
                revision: 1,
                roles: Object.fromEntries(
                  f.settings.roles.map((status) => [
                    String(status.status_id),
                    status.status_id === f.shipped.status_id
                      ? "excluded"
                      : status.role,
                  ]),
                ),
              });
              await tx
                .update(issues)
                .set({ statusId: f.done.status_id })
                .where(eq(issues.id, f.issue.id));
              // Historical timestamps make event visibility observable in the
              // requested range even though the commit happens after as_of.
              await tx.insert(issueEvents).values({
                projectId: f.project.id,
                issueId: f.issue.id,
                actorId: f.issue.authorId,
                type: "closed",
                createdAt: new Date("2026-01-02T12:00:00Z"),
                payload: {
                  from: { id: f.todo.status_id },
                  to: { id: f.done.status_id },
                },
              });
              const [added] = await tx
                .insert(issues)
                .values({
                  projectId: f.project.id,
                  number: f.issue.number + 1,
                  title: "committed during snapshot",
                  statusId: f.done.status_id,
                  authorId: f.issue.authorId,
                  createdAt: new Date("2026-01-02T13:00:00Z"),
                })
                .returning();
              if (!added) throw new Error("concurrent issue missing");
              await tx.insert(issueEvents).values({
                projectId: f.project.id,
                issueId: added.id,
                actorId: f.issue.authorId,
                type: "opened",
                createdAt: added.createdAt,
                payload: {},
              });
            });
          },
        }),
      );
      registerErrorHandler(app);
      const response = await app.request(`${f.path}?${f.query}`, {
        headers: { cookie },
      });
      expect(response.status).toBe(200);
      const during = BurnResponse.parse(await json(response));
      expect(hookCalls).toBe(1);
      // Exclude only the per-request clock. Settings, cohort, all event-derived
      // stock/flow and coverage must still equal the pre-commit HTTP response.
      expect(during).toEqual({ ...before, as_of: during.as_of });

      // A normal, fresh request must see the commit: guards against a no-op
      // writer, writing the wrong database, or a hook that was never reached.
      const after = await burn(f.path, f.query);
      expect(after.settings_version).not.toBe(before.settings_version);
      expect(
        after.statuses.find((status) => status.status_id === f.todo.status_id),
      ).toMatchObject({ color: "#123456" });
      expect(
        after.statuses.find(
          (status) => status.status_id === f.shipped.status_id,
        ),
      ).toMatchObject({ role: "excluded" });
      expect(after.cohort.count).toBe(2);
      expect(
        after.buckets.map((bucket) => bucket.stock?.remaining.value),
      ).toEqual([1, 0, 0]);
      expect(after.buckets[1]?.stock?.scope.value).toBe(2);
      expect(after.buckets[1]?.flow?.completed.value).toBe(1);
      expect(after.buckets[1]?.flow?.created_completed.value).toBe(1);
      expect(after.history_coverage.has_unknown).toBe(false);
    } finally {
      await client.end();
    }
  });

  it.each([
    "malformed_event",
    "broken_transition_chain",
    "membership_boundary_unknown",
  ] as const)(
    "carries %s from stored events through replay and aggregation to HTTP coverage",
    async (reason) => {
      const f = await fixture();
      await f.db.insert(issueEvents).values({
        projectId: f.project.id,
        issueId: f.issue.id,
        actorId: f.issue.authorId,
        createdAt: new Date("2026-01-02T12:00:00Z"),
        type: reason === "membership_boundary_unknown" ? "moved_in" : "closed",
        payload:
          reason === "broken_transition_chain"
            ? { from: { id: f.todo.status_id }, to: { id: f.done.status_id } }
            : {},
      });
      const body = await burn(f.path, f.query);
      expect(body.history_coverage).toMatchObject({
        has_unknown: true,
        reasons: [reason],
      });
      const unknown = { value: null, known: 0, unknown: 1 };
      if (reason === "membership_boundary_unknown") {
        expect(body.buckets.map((bucket) => bucket.reasons)).toEqual([
          [],
          [reason],
          [reason],
        ]);
        expect(body.buckets.map((bucket) => bucket.quality)).toEqual([
          "exact",
          "unknown",
          "unknown",
        ]);
        expect(body.buckets[1]?.flow?.moved_in_remaining).toEqual(unknown);
        expect(body.buckets[1]?.stock?.remaining).toEqual(unknown);
        expect(body.buckets[2]?.stock?.remaining).toEqual(unknown);
        expect(body.buckets[2]?.flow?.moved_in_remaining).toEqual({
          value: 0,
          known: 0,
          unknown: 0,
        });
        // Repair only the boundary evidence; the ordinary API must recover.
        await f.db
          .update(issueEvents)
          .set({ payload: { move_token: "fixture-move" } })
          .where(
            and(
              eq(issueEvents.issueId, f.issue.id),
              eq(issueEvents.type, "moved_in"),
            ),
          );
        const repaired = await burn(f.path, f.query);
        expect(repaired.history_coverage).toMatchObject({
          has_unknown: false,
          reasons: [],
        });
        expect(repaired.buckets.map((bucket) => bucket.quality)).toEqual([
          "exact",
          "exact",
          "exact",
        ]);
        expect(repaired.buckets[1]?.flow?.moved_in_remaining.value).toBe(1);
      } else {
        expect(body.buckets.map((bucket) => bucket.reasons)).toEqual([
          [reason],
          [reason],
          [],
        ]);
        expect(body.buckets.map((bucket) => bucket.quality)).toEqual([
          "unknown",
          "mixed",
          "exact",
        ]);
        expect(body.buckets[0]?.stock?.remaining).toEqual(unknown);
        expect(body.buckets[1]?.flow?.completed).toEqual(unknown);
        expect(body.buckets[2]?.stock?.remaining).toEqual({
          value: 1,
          known: 1,
          unknown: 0,
        });
        // Issue-wide reasons would incorrectly contaminate a recovered range.
        const recoveredQuery = new URLSearchParams(f.query);
        recoveredQuery.set("from", "2026-01-03T00:00:00Z");
        const recovered = await burn(f.path, recoveredQuery);
        expect(recovered.history_coverage).toMatchObject({
          has_unknown: false,
          reasons: [],
        });
        expect(recovered.buckets[0]?.quality).toBe("exact");
      }
    },
  );

  it("serializes two first saves against the same settings version", async () => {
    const settingsResponse = await t.app.request(
      `/api/projects/${slug}/insights/settings`,
      { headers: { cookie } },
    );
    expect(settingsResponse.status).toBe(200);
    const settings = Settings.parse(await json(settingsResponse));
    const roles = settings.roles.map((role, index) => ({
      status_id: role.status_id,
      role: index === 0 ? "excluded" : role.role,
    }));
    const request = () =>
      t.app.request(`/api/projects/${slug}/insights/settings`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ version: settings.version, roles }),
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });

  it.each([
    ["America/New_York", "2026-03-08", "2026-03-10", [23, 24]],
    ["Asia/Kolkata", "2026-01-01", "2026-01-03", [24, 24]],
    ["Pacific/Apia", "2011-12-29", "2012-01-01", [24, 24]],
  ] as const)(
    "uses database calendar boundaries for %s",
    async (tz, from, to, expectedHours) => {
      const response = await t.app.request(
        `/api/projects/${slug}/insights/burn?${new URLSearchParams({ from, to, grain: "1d", tz })}`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      const body = BurnResponse.parse(await json(response));
      const hours = body.buckets.map(
        (bucket) =>
          (Date.parse(bucket.end) - Date.parse(bucket.start)) /
          (60 * 60 * 1000),
      );
      expect(hours).toEqual(expectedHours);
    },
  );
});
