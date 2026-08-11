import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revisions } from "../src/db/project-schema.ts";
import { projectMembers, tokens, users } from "../src/db/system-schema.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

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

  it("serves paired issue and comment history, newest first", async () => {
    const issue = await createIssue({ title: "hist", body: "v1" });
    await patchIssue(issue.number, { body: "v2" });
    await patchIssue(issue.number, { body: "v3" });

    const page = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/revisions`,
        { headers: { cookie } },
      ),
    );
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
      page.items.map((r: any) => [r.body_before, r.body_after]),
    ).toEqual([
      ["v2", "v3"],
      ["v1", "v2"],
    ]);
    expect(page.items[0].actor.login).toBe("user");

    const comment = await addComment(issue.number, "c1");
    await patchComment(issue.number, comment.id, "c2");
    await patchComment(issue.number, comment.id, "c3");
    const commentPage = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/comments/${comment.id}/revisions`,
        { headers: { cookie } },
      ),
    );
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
      commentPage.items.map((r: any) => [r.body_before, r.body_after]),
    ).toEqual([
      ["c2", "c3"],
      ["c1", "c2"],
    ]);
  });

  it("limit truncation only drops older edits whole", async () => {
    const issue = await createIssue({ title: "trunc", body: "v1" });
    await patchIssue(issue.number, { body: "v2" });
    await patchIssue(issue.number, { body: "v3" });

    const page = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/revisions?limit=1`,
        { headers: { cookie } },
      ),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].body_before).toBe("v2");
    expect(page.items[0].body_after).toBe("v3");
  });

  it("404s for a comment fetched via the wrong issue", async () => {
    const withComment = await createIssue({ title: "has comment" });
    const other = await createIssue({ title: "other" });
    const comment = await addComment(withComment.number, "hello");

    const res = await t.app.request(
      `/api/projects/${slug}/issues/${other.number}/comments/${comment.id}/revisions`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("lets readers view history and ghosts deleted editors", async () => {
    const editor = await addUserWithToken(t.ctx, `editor-${slug}`);
    const reader = await addUserWithToken(t.ctx, `reader-${slug}`);
    for (const [user, role] of [
      [editor, "writer"],
      [reader, "reader"],
    ] as const) {
      const put = await t.app.request(
        `/api/projects/${slug}/members/${user.user.id}`,
        {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify({ role }),
        },
      );
      expect(put.status).toBe(204);
    }

    const issue = await createIssue({ title: "ghosted", body: "original" });
    const patched = await t.app.request(
      `/api/projects/${slug}/issues/${issue.number}`,
      {
        method: "PATCH",
        headers: { ...editor.headers, "content-type": "application/json" },
        body: JSON.stringify({ body: "edited by ghost-to-be" }),
      },
    );
    expect(patched.status).toBe(200);

    const system = t.ctx.router.system();
    await system.delete(tokens).where(eq(tokens.userId, editor.user.id));
    await system
      .delete(projectMembers)
      .where(eq(projectMembers.userId, editor.user.id));
    await system.delete(users).where(eq(users.id, editor.user.id));

    const page = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/revisions`,
        { headers: reader.headers },
      ),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].actor.login).toBe("ghost");
    expect(page.items[0].body_before).toBe("original");
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
