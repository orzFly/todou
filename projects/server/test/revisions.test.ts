import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revisions } from "../src/db/project-schema.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe.each(PLACEMENTS)("revisions capture (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let projectId: number;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    slug = `rev-${placement.replaceAll(/[^a-z]/g, "")}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Revisions" }),
    });
    expect(res.status).toBe(201);
    projectId = (await json(res)).id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(body: Record<string, unknown>) {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function patchIssue(number: number, body: Record<string, unknown>) {
    const res = await t.app.request(`/api/projects/${slug}/issues/${number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  async function addComment(number: number, body: string) {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments`,
      { method: "POST", headers: headers(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(201);
    return json(res);
  }

  async function patchComment(number: number, commentId: number, body: string) {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${number}/comments/${commentId}`,
      { method: "PATCH", headers: headers(), body: JSON.stringify({ body }) },
    );
    expect(res.status).toBe(200);
    return json(res);
  }

  async function revisionRows(subjectType: string, subjectId: number) {
    const db = await t.ctx.router.forProject({
      id: projectId,
      slug,
      database_url: null,
    });
    return db
      .select()
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, projectId),
          eq(revisions.subjectType, subjectType as "issue_body" | "comment"),
          eq(revisions.subjectId, subjectId),
        ),
      )
      .orderBy(revisions.id);
  }

  it("records a revision per body-changing issue edit", async () => {
    const issue = await createIssue({ title: "potato", body: "v1" });
    expect(issue.body_edited_at).toBeNull();

    const once = await patchIssue(issue.number, { body: "v2" });
    expect(once.body_edited_at).not.toBeNull();
    const twice = await patchIssue(issue.number, { body: "v3" });
    expect(Date.parse(twice.body_edited_at)).toBeGreaterThanOrEqual(
      Date.parse(once.body_edited_at),
    );

    const rows = await revisionRows("issue_body", issue.id);
    expect(rows.map((r) => r.body)).toEqual(["v1", "v2"]);
  });

  it("ignores title-only edits and identical bodies", async () => {
    const issue = await createIssue({ title: "before", body: "same" });
    await patchIssue(issue.number, { title: "after" });
    await patchIssue(issue.number, { body: "same" });

    expect(await revisionRows("issue_body", issue.id)).toHaveLength(0);
    const fetched = await json(
      await t.app.request(`/api/projects/${slug}/issues/${issue.number}`, {
        headers: { cookie },
      }),
    );
    expect(fetched.body_edited_at).toBeNull();
  });

  it("records comment revisions; no-op saves record nothing", async () => {
    const issue = await createIssue({ title: "commented" });
    const comment = await addComment(issue.number, "first");

    const edited = await patchComment(issue.number, comment.id, "second");
    expect(edited.edited_at).not.toBeNull();
    expect(edited.body).toBe("second");

    const seen: string[] = [];
    const off = t.ctx.bus.subscribe(projectId, (e) =>
      seen.push(`${e.entity}:${e.action}`),
    );
    const noop = await patchComment(issue.number, comment.id, "second");
    off();
    expect(seen).toEqual([]);
    expect(noop.edited_at).toBe(edited.edited_at);

    const rows = await revisionRows("comment", comment.id);
    expect(rows.map((r) => r.body)).toEqual(["first"]);
  });

  it("cascades revisions when a comment is deleted", async () => {
    const issue = await createIssue({ title: "doomed" });
    const comment = await addComment(issue.number, "one");
    await patchComment(issue.number, comment.id, "two");
    expect(await revisionRows("comment", comment.id)).toHaveLength(1);

    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}`,
      { method: "DELETE", headers: headers() },
    );
    expect(res.status).toBe(204);
    expect(await revisionRows("comment", comment.id)).toHaveLength(0);
  });
});
