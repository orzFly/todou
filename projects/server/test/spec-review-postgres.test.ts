import type { ChangeEvent } from "@todou/shared";
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

// Explicitly skipped without TODOU_TEST_POSTGRES_URL. PGlite's single
// connection cannot prove that a pre-lock approval query races with a commit.
describe.skipIf(!PG_URL)("personal spec approvals on real PostgreSQL", () => {
  let t: TestApp;
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  let projectId: number;
  let author: { user: UserRow; headers: { authorization: string } };
  let reviewer: { user: UserRow; headers: { authorization: string } };
  const slug = `review-pg-${Date.now().toString(36)}`;
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
    holderPid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    const observerPid = (
      await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    expect(observerPid).not.toBe(holderPid);
    author = await addUserWithToken(t.ctx, `${slug}-author`);
    reviewer = await addUserWithToken(t.ctx, `${slug}-reviewer`);
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Personal approval races" }),
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
      body: JSON.stringify({ title: "Concurrent personal approval" }),
    });
    expect(response.status).toBe(201);
    const issue = (await json(response)) as { id: number; number: number };
    const pushed = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/spec/push`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          files: [{ path: "design.md", body: "The proposed design.\n" }],
        }),
      },
    );
    expect(pushed.status).toBe(200);
    return issue;
  }

  function review(
    number: number,
    marker: string,
    verdict: "approve" | "request_changes" = "approve",
  ) {
    return Promise.resolve(
      t.app.request(`/api/projects/${slug}/issues/${number}/spec/reviews`, {
        method: "POST",
        headers: headers(reviewer),
        body: JSON.stringify({
          version: 1,
          verdict,
          body: `${marker} summary`,
          comments: [
            {
              anchor: {
                version: 1,
                path: "design.md",
                line_start: 1,
                line_end: 1,
              },
              body: `${marker} annotation`,
            },
          ],
        }),
      }),
    );
  }

  async function personalState(number: number) {
    const response = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec`,
      { headers: headers(reviewer) },
    );
    expect(response.status).toBe(200);
    return json(response);
  }

  async function waitForLockWaiters(count: number) {
    await expect
      .poll(
        async () => {
          // Follow both direct blockers and the tuple-lock queue behind the
          // first waiter. Other suites' locks cannot satisfy this barrier.
          const result = await observer.query<{ count: string }>(
            `WITH RECURSIVE blocked(pid) AS (
               SELECT $1::integer
               UNION
               SELECT activity.pid
               FROM pg_stat_activity activity
               JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             )
             SELECT count(*) FROM pg_stat_activity
             WHERE pid IN (SELECT pid FROM blocked WHERE pid <> $1)
               AND datname = current_database()
               AND wait_event_type = 'Lock'
               AND lower(query) LIKE 'select%'
               AND lower(query) LIKE '%"issues"%for update%'`,
            [holderPid],
          );
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
    const running: Promise<Response>[] = [];
    await holder.query("BEGIN");
    try {
      await holder.query("SELECT id FROM issues WHERE id = $1 FOR UPDATE", [
        issueId,
      ]);
      running.push(first());
      await waitForLockWaiters(1);
      running.push(second());
      await waitForLockWaiters(2);
      // Both HTTP requests have completed any pre-lock queries, and neither
      // can commit yet. In the initial-approval case, moving the personal
      // state query outside FOR UPDATE gives both the same stale false.
      await holder.query("COMMIT");
      return await Promise.all(running);
    } finally {
      await holder.query("ROLLBACK");
      await Promise.allSettled(running);
    }
  }

  async function snapshot(issueId: number) {
    const db = t.ctx.router.system();
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.id, issueId)));
    if (!issue) throw new Error("missing review race issue");
    return {
      issue,
      events: await db
        .select()
        .from(issueEvents)
        .where(eq(issueEvents.issueId, issueId))
        .orderBy(issueEvents.id),
      comments: await db
        .select()
        .from(comments)
        .where(eq(comments.issueId, issueId))
        .orderBy(comments.id),
      versions: await db
        .select()
        .from(specVersions)
        .where(eq(specVersions.issueId, issueId))
        .orderBy(specVersions.id),
    };
  }

  it("serializes two initial approvals by one actor to one 201, one 409 and only the winner's writes", async () => {
    const issue = await createSpec();
    expect(await personalState(issue.number)).toMatchObject({
      current_version: 1,
      review_status: "unreviewed",
      viewer_review: {
        user_id: reviewer.user.id,
        approved_in_current_round: false,
      },
    });
    const before = await snapshot(issue.id);
    expect(before.events.filter((e) => e.type === "spec_review")).toEqual([]);
    expect(before.comments).toEqual([]);
    const seen: ChangeEvent[] = [];
    const off = t.ctx.bus.subscribe((pid, event) => {
      if (pid === projectId && event.issue_number === issue.number)
        seen.push(event);
    });
    try {
      const responses = await race(
        issue.id,
        () => review(issue.number, "first"),
        () => review(issue.number, "second"),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        201, 409,
      ]);
      const loser = responses.find((response) => response.status === 409);
      expect(await json(loser!)).toMatchObject({
        error: {
          code: "conflict",
          message: expect.stringContaining(
            "already approved v1 in the current review round",
          ),
        },
      });
      const winnerIndex = responses.findIndex(
        (response) => response.status === 201,
      );
      const winner = await json(responses[winnerIndex]!);
      const marker = winnerIndex === 0 ? "first" : "second";
      expect(winner).toMatchObject({ version: 1, verdict: "approve" });
      expect(winner.comment_ids).toHaveLength(1);
      expect(winner.summary_comment_id).toEqual(expect.any(Number));
      const after = await snapshot(issue.id);
      expect(after.events).toHaveLength(before.events.length + 1);
      expect(after.events.filter((e) => e.type === "spec_review")).toEqual([
        expect.objectContaining({
          id: winner.event_id,
          actorId: reviewer.user.id,
          payload: {
            version: 1,
            verdict: "approve",
            comment_id: winner.summary_comment_id,
            annotation_count: 1,
          },
        }),
      ]);
      expect(after.comments).toEqual([
        expect.objectContaining({
          id: winner.comment_ids[0],
          authorId: reviewer.user.id,
          body: `${marker} annotation`,
        }),
        expect.objectContaining({
          id: winner.summary_comment_id,
          authorId: reviewer.user.id,
          body: `${marker} summary`,
        }),
      ]);
      expect(after.versions).toEqual(before.versions);
      expect(after.issue).toMatchObject({
        specVersion: 1,
        specReviewStatus: "approved",
        specUnresolvedComments: 1,
      });
      expect(seen).toEqual([
        expect.objectContaining({
          entity: "timeline",
          id: winner.comment_ids[0],
          action: "created",
        }),
        expect.objectContaining({
          entity: "timeline",
          id: winner.summary_comment_id,
          action: "created",
        }),
        expect.objectContaining({
          entity: "timeline",
          id: winner.event_id,
          action: "created",
        }),
        expect.objectContaining({
          entity: "spec",
          id: issue.id,
          action: "updated",
        }),
        expect.objectContaining({
          entity: "issue",
          id: issue.id,
          action: "updated",
        }),
      ]);
      expect((await personalState(issue.number)).viewer_review).toEqual({
        user_id: reviewer.user.id,
        approved_in_current_round: true,
      });
      // The race proves the loser adds no comments, events, counter increments
      // or bus publications. A subsequent rejection also compares updatedAt
      // exactly; that field necessarily changes for the race's winning write.
      expect((await review(issue.number, "rejected retry")).status).toBe(409);
      expect(await snapshot(issue.id)).toEqual(after);
      expect(seen).toHaveLength(5);
    } finally {
      off();
    }
  });

  it("reads the new round after a queued request_changes commits", async () => {
    const issue = await createSpec();
    expect((await review(issue.number, "initial")).status).toBe(201);
    const [reset, approval] = await race(
      issue.id,
      () => review(issue.number, "reset", "request_changes"),
      () => review(issue.number, "new round"),
    );
    expect(reset?.status).toBe(201);
    expect(approval?.status).toBe(201);
    const resetResult = await json(reset!);
    const approvalResult = await json(approval!);
    expect(resetResult.event_id).toBeLessThan(approvalResult.event_id);
    const state = await snapshot(issue.id);
    expect(
      state.events
        .filter((e) => e.type === "spec_review")
        .map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({ verdict: "approve", version: 1 }),
      expect.objectContaining({ verdict: "request_changes", version: 1 }),
      expect.objectContaining({ verdict: "approve", version: 1 }),
    ]);
    expect(state.comments).toHaveLength(6);
    expect(state.issue.specUnresolvedComments).toBe(3);
    expect(state.issue.specReviewStatus).toBe("approved");
    expect((await personalState(issue.number)).viewer_review).toEqual({
      user_id: reviewer.user.id,
      approved_in_current_round: true,
    });
    expect((await review(issue.number, "duplicate new round")).status).toBe(
      409,
    );
    expect(await snapshot(issue.id)).toEqual(state);
  });
});
