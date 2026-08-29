import type { ChangeEvent } from "@todou/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * T-101: `updated_at` means "last activity on this card". Every assertion
 * plants a known-old timestamp first and compares against it, so the suite
 * cannot pass by accident on a clock too coarse to separate two writes —
 * PGlite only ever produces milliseconds.
 */
const PLANTED = "2020-01-01T00:00:00.000Z";

describe("issue updated_at activity policy T-101", () => {
  let t: TestApp;
  let cookie: string;
  let agentHeaders: Record<string, string>;
  let projectId = 0;
  const slug = "updated-at";
  const headers = () => ({ "content-type": "application/json", cookie });
  const asAgent = () => ({
    "content-type": "application/json",
    ...agentHeaders,
  });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Updated at" }),
    });
    expect(res.status).toBe(201);
    projectId = (await json(res)).id;

    // Spec review needs an actor who is not the pusher.
    const agent = await addUserWithToken(t.ctx, "updated-at-agent", {
      kind: "machine",
    });
    agentHeaders = agent.headers;
    const member = await t.app.request(
      `/api/projects/${slug}/members/${agent.user.id}`,
      {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ role: "writer" }),
      },
    );
    expect(member.status).toBe(204);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(title: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  /** Backdate updated_at so any real bump is unambiguously newer. */
  async function plant(number: number): Promise<void> {
    await t.ctx.router
      .system()
      .execute(
        sql`update issues set updated_at = ${PLANTED}::timestamptz where project_id = ${projectId} and number = ${number}`,
      );
    expect(await updatedAt(number)).toBe(PLANTED);
  }

  async function updatedAt(number: number): Promise<string> {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await json(res)).updated_at;
  }

  const expectBumped = async (number: number) =>
    expect(Date.parse(await updatedAt(number))).toBeGreaterThan(
      Date.parse(PLANTED),
    );
  const expectUntouched = async (number: number) =>
    expect(await updatedAt(number)).toBe(PLANTED);

  async function comment(number: number, body: string): Promise<number> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      { method: "POST", headers: headers(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(201);
    return (await json(res)).id;
  }

  async function pushSpec(number: number, body: string): Promise<void> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/push`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({ files: [{ path: "design.md", body }] }),
      },
    );
    expect(res.status).toBe(200);
  }

  it("bumps on a new comment", async () => {
    const number = await createIssue("comment host");
    await plant(number);
    await comment(number, "a plain remark");
    await expectBumped(number);
  });

  it("bumps on an attachment", async () => {
    const number = await createIssue("attachment host");
    await plant(number);
    const form = new FormData();
    form.set("file", new File(["potato bytes"], "notes.txt"));
    form.set("issue_number", String(number));
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(res.status).toBe(201);
    await expectBumped(number);
  });

  it("bumps when questions are answered", async () => {
    const number = await createIssue("question host");
    const asked = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          body: "context…",
          component: {
            type: "questions",
            questions: [
              {
                key: "where",
                question: "Where?",
                options: [{ label: "here" }, { label: "there" }],
              },
            ],
          },
        }),
      },
    );
    expect(asked.status).toBe(201);
    const commentId = (await json(asked)).id;

    // Plant after asking: the question comment is itself a bump.
    await plant(number);
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments/${commentId}/answers`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          answers: [{ key: "where", selected: [0] }],
        }),
      },
    );
    expect(res.status).toBe(201);
    await expectBumped(number);
  });

  it("bumps on a spec push and again on a spec review", async () => {
    const number = await createIssue("spec host");
    await plant(number);
    await pushSpec(number, "# Design\n\nOne.\nTwo.\n");
    await expectBumped(number);

    await plant(number);
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/reviews`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          version: 1,
          verdict: "request_changes",
          body: "One nit.",
          comments: [
            {
              anchor: {
                path: "design.md",
                version: 1,
                line_start: 3,
                line_end: 3,
              },
              body: "Say more.",
            },
          ],
        }),
      },
    );
    expect(res.status).toBe(201);
    await expectBumped(number);
  });

  it("leaves the target untouched when another issue references it", async () => {
    const target = await createIssue("reference target");
    await plant(target);

    // Both reference paths: a comment body and an issue body.
    const source = await createIssue("reference source");
    await comment(source, `follows on from #${target}`);
    await expectUntouched(target);

    const viaBody = await createIssue("reference source via body");
    const edited = await t.app.request(
      `/api/projects/${slug}/issues/${viaBody}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ body: `blocked by #${target}` }),
      },
    );
    expect(edited.status).toBe(200);
    await expectUntouched(target);

    // The referencing cards did move — the write landed on their own row.
    expect(Date.parse(await updatedAt(source))).toBeGreaterThan(
      Date.parse(PLANTED),
    );
  });

  it("leaves updated_at alone when spec comments are resolved", async () => {
    const number = await createIssue("resolve host");
    await pushSpec(number, "# Design\n\nOne.\nTwo.\n");
    const review = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/reviews`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          version: 1,
          verdict: "request_changes",
          body: "One nit.",
          comments: [
            {
              anchor: {
                path: "design.md",
                version: 1,
                line_start: 3,
                line_end: 3,
              },
              body: "Say more.",
            },
          ],
        }),
      },
    );
    expect(review.status).toBe(201);
    const { comment_ids } = await json(review);

    await plant(number);
    const resolved = await t.app.request(
      `/api/projects/${slug}/issues/${number}/spec/comments/resolve`,
      {
        method: "POST",
        headers: asAgent(),
        body: JSON.stringify({ comment_ids }),
      },
    );
    expect(resolved.status).toBe(200);
    await expectUntouched(number);
  });

  it("leaves updated_at alone when a comment is edited or deleted", async () => {
    const number = await createIssue("comment edit host");
    const commentId = await comment(number, "first draft");

    await plant(number);
    const edited = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments/${commentId}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ body: "second draft" }),
      },
    );
    expect(edited.status).toBe(200);
    await expectUntouched(number);

    const deleted = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments/${commentId}`,
      { method: "DELETE", headers: headers() },
    );
    expect(deleted.status).toBe(204);
    await expectUntouched(number);
  });

  /**
   * The web narrows a lone timeline event to the list pages already holding
   * the row (T-91) and leans on the paired `issue` event to catch reordering.
   * Drop that pairing and a comment silently stops lifting its card until
   * the next full refetch — so the pairing is asserted, not assumed.
   */
  it("pairs a bumping timeline entry with an issue event, a reference alone", async () => {
    const number = await createIssue("sse pairing host");
    const target = await createIssue("sse pairing target");

    const seen: ChangeEvent[] = [];
    const off = t.ctx.bus.subscribe((pid, e) => {
      if (pid === projectId) seen.push(e);
    });
    try {
      await comment(number, `see also #${target}`);
    } finally {
      off();
    }

    const kinds = (issueNumber: number) =>
      seen
        .filter((e) => e.issue_number === issueNumber)
        .map((e) => `${e.entity}:${e.action}`)
        .sort();
    expect(kinds(number)).toEqual(["issue:updated", "timeline:created"]);
    // The referenced card gets the entry but no bump, so no issue event.
    expect(kinds(target)).toEqual(["timeline:created"]);
  });
});

/**
 * The layer the bump policy actually moves for users: the web issue list
 * (and the T-88 status-grouped list) sorts by `updated_at desc`, so every
 * new bump reorders a page and shifts the cursors that page hands out.
 */
describe("issue list ordering under sort=updated T-101", () => {
  let t: TestApp;
  let cookie: string;
  let projectId = 0;
  const slug = "updated-at-list";
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Updated at ordering" }),
    });
    expect(res.status).toBe(201);
    projectId = (await json(res)).id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(title: string): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number;
  }

  /** Pin updated_at so the expected order does not depend on clock ticks. */
  async function plantAt(number: number, at: string): Promise<void> {
    await t.ctx.router
      .system()
      .execute(
        sql`update issues set updated_at = ${at}::timestamptz where project_id = ${projectId} and number = ${number}`,
      );
  }

  async function comment(number: number, body: string): Promise<void> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      { method: "POST", headers: headers(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(201);
  }

  const order = async (qs: string): Promise<number[]> => {
    const res = await t.app.request(`/api/projects/${slug}/issues?${qs}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await json(res)).items.map((i: { number: number }) => i.number);
  };

  /** Follow next_cursor to the end; throws if the walk stops advancing. */
  async function drain(qs: string, maxPages: number): Promise<number[]> {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < maxPages; pages += 1) {
      const res = await t.app.request(
        `/api/projects/${slug}/issues?${qs}${
          cursor === undefined ? "" : `&cursor=${cursor}`
        }`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const page = await json(res);
      seen.push(...page.items.map((i: { number: number }) => i.number));
      if (page.next_cursor === null) return seen;
      expect(page.next_cursor).not.toBe(cursor);
      cursor = page.next_cursor;
    }
    throw new Error(`drain did not terminate in ${maxPages} pages`);
  }

  it("a comment lifts its issue to the head of the list", async () => {
    const a = await createIssue("oldest");
    const b = await createIssue("middle");
    const c = await createIssue("newest");
    await plantAt(a, "2020-01-01T00:00:00.000Z");
    await plantAt(b, "2020-01-02T00:00:00.000Z");
    await plantAt(c, "2020-01-03T00:00:00.000Z");
    expect(await order("sort=updated&order=desc")).toEqual([c, b, a]);

    await comment(a, "still alive");
    expect(await order("sort=updated&order=desc")).toEqual([a, c, b]);
    // sort=created is the server default and must not have moved.
    expect(await order("sort=created&order=desc")).toEqual([c, b, a]);
  });

  it("reorders inside a status group without disturbing its neighbour", async () => {
    const statuses = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
    // Any two non-default statuses: earlier tests already parked issues in
    // the default one.
    const [own, neighbour] = (statuses.items ?? statuses).filter(
      (s: { is_default: boolean }) => !s.is_default,
    );
    expect(neighbour).toBeDefined();

    const x = await createIssue("group x");
    const y = await createIssue("group y");
    const other = await createIssue("other group");
    for (const [n, status] of [
      [x, own],
      [y, own],
      [other, neighbour],
    ] as const) {
      const res = await t.app.request(`/api/projects/${slug}/issues/${n}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status_id: status.id }),
      });
      expect(res.status).toBe(200);
    }

    await plantAt(x, "2021-01-01T00:00:00.000Z");
    await plantAt(y, "2021-01-02T00:00:00.000Z");
    await plantAt(other, "2021-01-03T00:00:00.000Z");
    const group = `status=${own.id}&sort=updated&order=desc`;
    expect(await order(group)).toEqual([y, x]);

    await comment(x, "bumped");
    expect(await order(group)).toEqual([x, y]);
    expect(
      await order(`status=${neighbour.id}&sort=updated&order=desc`),
    ).toEqual([other]);
  });

  it("drains every issue exactly once while sorted by updated", async () => {
    const numbers: number[] = [];
    for (let n = 0; n < 5; n += 1) {
      numbers.push(await createIssue(`drain ${n}`));
    }
    // One shared millisecond: the cursor must fall back to the id
    // tie-break rather than re-serving or skipping the bucket.
    for (const n of numbers) await plantAt(n, "2022-05-05T05:05:05.000Z");
    await comment(numbers[0] as number, "lifted out of the bucket");

    const drained = await drain("sort=updated&order=desc&limit=1", 40);
    const inThisTest = drained.filter((n) => numbers.includes(n));
    expect(inThisTest).toEqual([
      numbers[0],
      numbers[4],
      numbers[3],
      numbers[2],
      numbers[1],
    ]);
    expect(new Set(drained).size).toBe(drained.length);
  });
});
