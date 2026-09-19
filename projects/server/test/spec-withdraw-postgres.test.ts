import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import {
  comments,
  issueEvents,
  issues,
  specVersions,
} from "../src/db/project-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const files = [{ path: "design.md", body: "The proposed design.\n" }];

// PGlite serializes on its one connection even without FOR UPDATE. These
// races use an external transaction and observe PostgreSQL's actual lock
// waiters before releasing either request; scheduling is never a timed guess.
describe.skipIf(!PG_URL)("spec withdrawal issue-lock races", () => {
  let t: TestApp;
  let holder: pg.Client;
  let observer: pg.Client;
  let projectId: number;
  let author: { user: UserRow; headers: { authorization: string } };
  let reviewer: { user: UserRow; headers: { authorization: string } };
  const slug = `withdraw-pg-${Date.now().toString(36)}`;
  const headers = (who = author) => ({
    ...who.headers,
    "content-type": "application/json",
  });

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    holder = new pg.Client({ connectionString: PG_URL });
    observer = new pg.Client({ connectionString: PG_URL });
    await holder.connect();
    await observer.connect();
    author = await addUserWithToken(t.ctx, `${slug}-author`);
    reviewer = await addUserWithToken(t.ctx, `${slug}-reviewer`);
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Withdrawal races" }),
    });
    expect(created.status).toBe(201);
    projectId = (await json(created)).id;
    const member = await t.app.request(
      `/api/projects/${slug}/members/${reviewer.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);
  });

  afterAll(async () => {
    await holder?.end();
    await observer?.end();
    await t?.cleanup();
  });

  async function createSpec() {
    const response = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Lock ordering" }),
    });
    expect(response.status).toBe(201);
    const issue = await json(response);
    expect((await mutate(issue.number, "push")).status).toBe(200);
    return issue as { id: number; number: number };
  }

  type Operation = "withdraw" | "push" | "approve" | "request_changes";
  function mutate(number: number, operation: Operation) {
    const reviewing =
      operation === "approve" || operation === "request_changes";
    return Promise.resolve(
      t.app.request(
        `/api/projects/${slug}/issues/${number}/spec/${reviewing ? "reviews" : operation}`,
        {
          method: "POST",
          headers: headers(reviewing ? reviewer : author),
          body: JSON.stringify(
            reviewing
              ? {
                  version: 1,
                  verdict: operation,
                  body: "Review summary must be atomic",
                  comments: [
                    {
                      anchor: {
                        version: 1,
                        path: "design.md",
                        line_start: 1,
                        line_end: 1,
                      },
                      body: "Review annotation must be atomic",
                    },
                  ],
                }
              : operation === "push"
                ? { files }
                : { version: 1, reason: "Reworking" },
          ),
        },
      ),
    );
  }

  async function waitForLockWaiters(count: number) {
    await expect
      .poll(
        async () => {
          const result = await observer.query<{ count: string }>(`
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
          AND lower(query) LIKE 'select%'
          AND lower(query) LIKE '%"issues"%for update%'
      `);
          return Number(result.rows[0]?.count);
        },
        { timeout: 5000, interval: 10 },
      )
      .toBe(count);
  }

  async function race(
    issueId: number,
    first: () => Promise<Response>,
    second: () => Promise<Response>,
  ) {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
      issueId,
    ]);
    const running: Promise<Response>[] = [];
    try {
      running.push(first());
      await waitForLockWaiters(1);
      running.push(second());
      await waitForLockWaiters(2);
      await holder.query("COMMIT");
      return await Promise.all(running);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(running);
    }
  }

  it.each(["approve", "request_changes"] as const)(
    "%s commits before withdrawal: withdrawal rejects the locked verdict",
    async (verdict) => {
      const issue = await createSpec();
      const [review, withdrawal] = await race(
        issue.id,
        () => mutate(issue.number, verdict),
        () => mutate(issue.number, "withdraw"),
      );
      expect(review?.status).toBe(201);
      expect(withdrawal?.status).toBe(409);
      const state = await snapshot(issue.id);
      expect(state.issue.specReviewStatus).toBe(
        verdict === "approve" ? "approved" : "changes_requested",
      );
      expect(
        state.events.filter((event) => event.type === "spec_withdrawn"),
      ).toHaveLength(0);
      expect(
        state.events.filter((event) => event.type === "spec_review"),
      ).toHaveLength(1);
      expect(state.comments).toHaveLength(2);
      expect(state.issue.specUnresolvedComments).toBe(1);
    },
  );

  it.each(["approve", "request_changes"] as const)(
    "withdrawal commits before %s: stale pre-lock state cannot admit any review writes",
    async (verdict) => {
      const issue = await createSpec();
      const [withdrawal, review] = await race(
        issue.id,
        () => mutate(issue.number, "withdraw"),
        () => mutate(issue.number, verdict),
      );
      expect(withdrawal?.status).toBe(200);
      expect(review?.status).toBe(409);
      const state = await snapshot(issue.id);
      expect(state.issue.specReviewStatus).toBe("withdrawn");
      expect(
        state.events.filter((event) => event.type === "spec_review"),
      ).toHaveLength(0);
      expect(
        state.events.filter((event) => event.type === "spec_withdrawn"),
      ).toHaveLength(1);
      expect(state.comments).toHaveLength(0);
      expect(state.issue.specUnresolvedComments).toBe(0);
    },
  );

  it("push commits before withdrawal: stale version cannot withdraw the new submission", async () => {
    const issue = await createSpec();
    const [pushed, withdrawal] = await race(
      issue.id,
      () =>
        Promise.resolve(
          t.app.request(
            `/api/projects/${slug}/issues/${issue.number}/spec/push`,
            {
              method: "POST",
              headers: headers(),
              body: JSON.stringify({
                files: [{ path: "design.md", body: "Changed.\n" }],
              }),
            },
          ),
        ),
      () => mutate(issue.number, "withdraw"),
    );
    expect(pushed?.status).toBe(200);
    expect(withdrawal?.status).toBe(409);
    const state = await snapshot(issue.id);
    expect(state.issue).toMatchObject({
      specVersion: 2,
      specReviewStatus: "unreviewed",
    });
    expect(
      state.events.filter((event) => event.type === "spec_withdrawn"),
    ).toHaveLength(0);
  });

  it("withdrawal commits before identical push: the locked status forces a new version", async () => {
    const issue = await createSpec();
    const [withdrawal, pushed] = await race(
      issue.id,
      () => mutate(issue.number, "withdraw"),
      () => mutate(issue.number, "push"),
    );
    expect(withdrawal?.status).toBe(200);
    expect(pushed?.status).toBe(200);
    expect(await json(pushed!)).toMatchObject({
      unchanged: false,
      version: 2,
      added: [],
      changed: [],
      removed: [],
    });
    const state = await snapshot(issue.id);
    expect(state.issue).toMatchObject({
      specVersion: 2,
      specReviewStatus: "unreviewed",
    });
    expect(state.versions).toHaveLength(2);
    expect(
      state.events.filter((event) => event.type === "spec_pushed"),
    ).toHaveLength(2);
    expect(
      state.events.filter((event) => event.type === "spec_withdrawn"),
    ).toHaveLength(1);
  });

  it("two withdrawals serialize to one event and the original cursor", async () => {
    const issue = await createSpec();
    const [first, second] = await race(
      issue.id,
      () => mutate(issue.number, "withdraw"),
      () => mutate(issue.number, "withdraw"),
    );
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    const initial = await json(first!);
    expect(initial.unchanged).toBe(false);
    expect(await json(second!)).toEqual({ ...initial, unchanged: true });
    const state = await snapshot(issue.id);
    expect(state.issue.specReviewStatus).toBe("withdrawn");
    expect(
      state.events.filter((event) => event.type === "spec_withdrawn"),
    ).toHaveLength(1);
    expect(state.versions).toHaveLength(1);
  });

  it.each(["deleted_at", "moving_since"] as const)(
    "withdrawal rechecks %s after acquiring the lock",
    async (column) => {
      const issue = await createSpec();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
        issue.id,
      ]);
      const pending = mutate(issue.number, "withdraw");
      try {
        await waitForLockWaiters(1);
        // column is a fixed test-only literal union, not request input.
        await holder.query(
          `UPDATE issues SET ${column} = now() WHERE id = $1`,
          [issue.id],
        );
        await holder.query("COMMIT");
        expect((await pending).status).toBe(409);
        const state = await snapshot(issue.id);
        expect(state.issue.specReviewStatus).toBe("unreviewed");
        expect(
          state.events.filter((event) => event.type === "spec_withdrawn"),
        ).toHaveLength(0);
      } finally {
        await holder.query("ROLLBACK");
        await pending;
      }
    },
  );

  async function snapshot(issueId: number) {
    const db = t.ctx.router.system();
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)));
    if (!issue) throw new Error("missing race issue");
    return {
      issue,
      events: await db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, issueId)),
      comments: await db
        .select()
        .from(comments)
        .where(eq(comments.issueId, issueId)),
      versions: await db
        .select()
        .from(specVersions)
        .where(eq(specVersions.issueId, issueId)),
    };
  }
});
