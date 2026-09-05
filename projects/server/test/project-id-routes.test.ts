import { CANONICAL_SLUG_HEADER } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * Every `/api/projects/{…}` route answers to a project id as well as to a
 * slug (T-266), because that is the spelling stored links are anchored on.
 */
describe("project id in the path", () => {
  let t: TestApp;
  let cookie: string;
  let id = 0;
  let otherId = 0;
  let issueNumber = 0;
  let commentId = 0;
  const SLUG = "id-routes";
  const OTHER = "id-routes-other";

  const req = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        cookie,
        ...init?.headers,
      },
    });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
    for (const slug of [SLUG, OTHER]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
      const project = await json(res);
      if (slug === SLUG) id = project.id;
      else otherId = project.id;
    }
    const issue = await json(
      await req(`/projects/${SLUG}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: "anchored", body: "hello" }),
      }),
    );
    issueNumber = issue.number;
    const comment = await json(
      await req(`/projects/${SLUG}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "a note" }),
      }),
    );
    commentId = comment.id;
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("reads an issue by id and says which slug is canonical", async () => {
    const res = await req(`/projects/${id}/issues/${issueNumber}`);
    expect(res.status).toBe(200);
    expect(res.headers.get(CANONICAL_SLUG_HEADER)).toBe(SLUG);
    expect((await json(res)).title).toBe("anchored");
  });

  it("reads a comment by id", async () => {
    const res = await req(
      `/projects/${id}/issues/${issueNumber}/comments/${commentId}`,
    );
    expect(res.status).toBe(200);
    expect((await json(res)).body).toBe("a note");
  });

  it("locates a bare comment id by project id", async () => {
    const res = await req(`/projects/${id}/comments/${commentId}`);
    expect(res.status).toBe(200);
    expect((await json(res)).issue_number).toBe(issueNumber);
  });

  it("reads the timeline, statuses and spec state by id", async () => {
    const pushed = await req(
      `/projects/${SLUG}/issues/${issueNumber}/spec/push`,
      {
        method: "POST",
        body: JSON.stringify({
          files: [{ path: "plan.md", body: "# plan" }],
          message: "v1",
        }),
      },
    );
    expect(pushed.status).toBe(200);

    for (const tail of [
      `/issues/${issueNumber}/timeline`,
      "/statuses",
      `/issues/${issueNumber}/spec`,
      `/issues/${issueNumber}/spec/files`,
    ]) {
      const res = await req(`/projects/${id}${tail}`);
      expect([tail, res.status]).toEqual([tail, 200]);
    }
  });

  it("downloads an attachment by project id", async () => {
    const form = new FormData();
    form.append("issue_number", String(issueNumber));
    form.append("file", new File(["hi"], "note.txt", { type: "text/plain" }));
    const upload = await t.app.request(`/api/projects/${SLUG}/attachments`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(upload.status).toBe(201);
    const attachment = await json(upload);
    const res = await req(
      `/projects/${id}/attachments/${attachment.id}/download`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
  });

  it("does not answer for a project the id does not name", async () => {
    const res = await req(`/projects/${otherId}/issues/${issueNumber}`);
    expect(res.status).toBe(404);
  });

  it("404s an id nobody holds, the same way a missing slug does", async () => {
    const byId = await req("/projects/99999/issues/1");
    const bySlug = await req("/projects/nobody-holds-this/issues/1");
    expect(byId.status).toBe(404);
    expect((await json(byId)).error.code).toBe((await json(bySlug)).error.code);
  });

  it("puts a write named by id through the same capability gate", async () => {
    // The two halves have to meet: the path names the project by id (T-266)
    // and the gate reads the role it needs from the catalog (T-264). The
    // gate resolves whatever spelling the path used, so an id must neither
    // bypass a check nor fail one it would have passed by slug.
    const reader = await addUserWithToken(t.ctx, "id-routes-reader");
    const reporter = await addUserWithToken(t.ctx, "id-routes-reporter");
    for (const [who, role] of [
      [reader, "reader"],
      [reporter, "reporter"],
    ] as const) {
      const res = await req(`/projects/${SLUG}/members/${who.user.id}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
      expect(res.status).toBe(204);
    }

    const open = (who: { authorization: string }) =>
      t.app.request(`/api/projects/${id}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify({ title: "by id", body: "" }),
      });

    // `issue.create` sits at reporter, so the ladder decides the answer —
    // not the spelling of the project.
    expect((await open(reporter.headers)).status).toBe(201);
    expect((await open(reader.headers)).status).toBe(403);

    // …and the same request by slug agrees, which is what makes the id form
    // a spelling rather than a second set of rules.
    const bySlug = await t.app.request(`/api/projects/${SLUG}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", ...reader.headers },
      body: JSON.stringify({ title: "by slug", body: "" }),
    });
    expect(bySlug.status).toBe(403);
  });

  it("refuses an all-digit slug on create and on rename", async () => {
    // Judged against a slug the shape rule already rejected, so the pair
    // cannot drift apart if the validation status ever changes.
    const badShape = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ slug: "Nope", name: "shape" }),
    });
    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ slug: "12345", name: "digits" }),
    });
    expect(created.status).toBe(badShape.status);
    expect(JSON.stringify(await json(created))).toContain("not all digits");

    const renamed = await req(`/projects/${SLUG}`, {
      method: "PATCH",
      body: JSON.stringify({ slug: "9" }),
    });
    expect(renamed.status).toBe(badShape.status);
  });
});
