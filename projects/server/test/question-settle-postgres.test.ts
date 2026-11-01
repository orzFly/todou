import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import { comments, issueEvents, issues } from "../src/db/project-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (response: Response): Promise<any> => response.json();
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

const option = (label: string) => ({ label });
const QUESTION = { question: "?", options: [option("a"), option("b")] };

// PGlite serializes every transaction on its one connection, so these races
// only exist on PostgreSQL. An external transaction holds a lock, and both
// requests are seen queued behind it before it lets go; nothing is timed.
describe.skipIf(!PG_URL)("question settlement races on PostgreSQL", () => {
  let t: TestApp;
  let holder: pg.Client;
  let observer: pg.Client;
  let holderPid: number;
  let projectId: number;
  let author: { user: UserRow; headers: { authorization: string } };
  let reviewer: { user: UserRow; headers: { authorization: string } };
  const slug = `settle-pg-${Date.now().toString(36)}`;
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
    const [backend] = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows;
    if (!backend) throw new Error("holder has no backend pid");
    holderPid = backend.pid;
    author = await addUserWithToken(t.ctx, `${slug}-author`);
    reviewer = await addUserWithToken(t.ctx, `${slug}-reviewer`);
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Settlement races" }),
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

  async function createIssue() {
    const response = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Settle once" }),
    });
    expect(response.status).toBe(201);
    return (await json(response)) as { id: number; number: number };
  }

  /** A card holding A (two questions) and B (one): `open_questions = 3`. */
  async function askTwo() {
    const issue = await createIssue();
    const ask = async (count: number) => {
      const response = await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            body: "context",
            component: {
              type: "questions",
              questions: Array.from({ length: count }, () => QUESTION),
            },
          }),
        },
      );
      expect(response.status).toBe(201);
      return (await json(response)).id as number;
    };
    const a = await ask(2);
    await ask(1);
    expect((await snapshot(issue.id)).issue.openQuestions).toBe(3);
    return { issue, a };
  }

  function answerA(number: number, commentId: number) {
    return Promise.resolve(
      t.app.request(
        `/api/projects/${slug}/issues/${number}/comments/${commentId}/answers`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            answers: [
              { key: "q1", selected: [0] },
              { key: "q2", selected: [1] },
            ],
          }),
        },
      ),
    );
  }

  function remove(number: number, commentId: number) {
    return Promise.resolve(
      t.app.request(
        `/api/projects/${slug}/issues/${number}/comments/${commentId}`,
        { method: "DELETE", headers: headers() },
      ),
    );
  }

  /** Requests queued behind the holder, directly or behind one another. */
  async function waitForLockWaiters(count: number) {
    await expect
      .poll(
        async () => {
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
               AND wait_event_type = 'Lock'`,
            [holderPid],
          );
          return Number(result.rows[0]?.count);
        },
        { timeout: 5000, interval: 10 },
      )
      .toBe(count);
  }

  /**
   * Hold `lock` (a `SELECT … FOR UPDATE` on one row), start `first` and wait
   * until it queues, start `second` and wait until it queues too, then let go.
   */
  async function race(
    lock: { sql: string; id: number },
    first: () => Promise<Response>,
    second: () => Promise<Response>,
  ) {
    const running: Promise<Response>[] = [];
    await holder.query("BEGIN");
    try {
      await holder.query(lock.sql, [lock.id]);
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

  // The lock a counter UPDATE takes. FOR UPDATE would also block the KEY
  // SHARE lock the foreign-key check on an inserted issue_events row takes,
  // stopping a request short of the counter and turning the race into a
  // deadlock instead of the double refund it is about.
  const issueLock = (id: number) => ({
    sql: "SELECT id FROM issues WHERE id = $1 FOR NO KEY UPDATE",
    id,
  });

  async function snapshot(issueId: number) {
    const db = t.ctx.router.system();
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.id, issueId)));
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
    };
  }

  const settlementsOf = (
    events: Array<typeof issueEvents.$inferSelect>,
    commentId: number,
  ) =>
    events.filter(
      (event) =>
        (event.payload as { comment_id?: number }).comment_id === commentId,
    );

  it("an answer that commits first is not refunded again by a delete", async () => {
    const { issue, a } = await askTwo();
    const [answered, deleted] = await race(
      issueLock(issue.id),
      () => answerA(issue.number, a),
      () => remove(issue.number, a),
    );
    expect(answered?.status).toBe(201);
    expect(deleted?.status).toBe(204);
    const state = await snapshot(issue.id);
    expect(state.issue.openQuestions).toBe(1);
    expect(state.comments.map((row) => row.id)).not.toContain(a);
  });

  it("an answer arriving after a delete finds no comment to answer", async () => {
    const { issue, a } = await askTwo();
    const [deleted, answered] = await race(
      issueLock(issue.id),
      () => remove(issue.number, a),
      () => answerA(issue.number, a),
    );
    expect(deleted?.status).toBe(204);
    expect(answered?.status).toBe(404);
    const state = await snapshot(issue.id);
    expect(state.issue.openQuestions).toBe(1);
    expect(settlementsOf(state.events, a)).toEqual([]);
  });

  it("a second delete of the same comment refunds nothing", async () => {
    const { issue, a } = await askTwo();
    const [first, second] = await race(
      issueLock(issue.id),
      () => remove(issue.number, a),
      () => remove(issue.number, a),
    );
    expect(first?.status).toBe(204);
    expect(second?.status).toBe(404);
    expect((await snapshot(issue.id)).issue.openQuestions).toBe(1);
  });

  it("a resolve that commits first is not refunded again by a delete", async () => {
    const issue = await createIssue();
    const pushed = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/spec/push`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          files: [{ path: "design.md", body: "One.\nTwo.\n" }],
        }),
      },
    );
    expect(pushed.status).toBe(200);
    const annotation = (line: number) => ({
      anchor: {
        version: 1,
        path: "design.md",
        line_start: line,
        line_end: line,
      },
      body: `line ${line}`,
    });
    const reviewed = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/spec/reviews`,
      {
        method: "POST",
        headers: headers(reviewer),
        body: JSON.stringify({
          version: 1,
          verdict: "comment",
          comments: [annotation(1), annotation(2)],
        }),
      },
    );
    expect(reviewed.status).toBe(201);
    const before = await snapshot(issue.id);
    expect(before.issue.specUnresolvedComments).toBe(2);
    const x = before.comments.find(
      (row) => row.component?.type === "spec_comment",
    );
    if (!x) throw new Error("missing annotation");

    const [resolved, deleted] = await race(
      issueLock(issue.id),
      () =>
        Promise.resolve(
          t.app.request(
            `/api/projects/${slug}/issues/${issue.number}/spec/comments/resolve`,
            {
              method: "POST",
              headers: headers(),
              body: JSON.stringify({ comment_ids: [x.id] }),
            },
          ),
        ),
      () => remove(issue.number, x.id),
    );
    expect(resolved?.status).toBe(200);
    expect(deleted?.status).toBe(204);
    expect((await snapshot(issue.id)).issue.specUnresolvedComments).toBe(1);
  });
});
