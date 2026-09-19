import { Issue, Project } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

const observe = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
  headers: [...response.headers.entries()],
  redirected: response.redirected,
});

describe("project existence privacy on issue reads (T-440)", () => {
  let t: TestApp;
  let readerHeaders: { authorization: string };
  const hidden = "private-project";
  const visible = "reader-project";
  const absent = "absent-project";
  let issueNumber: number;
  let hiddenId: number;

  beforeAll(async () => {
    t = await makeTestApp();
    const cookie = await t.login();
    const admin = { cookie, "content-type": "application/json" };
    const reader = await addUserWithToken(t.ctx, "ordinary-reader");
    readerHeaders = reader.headers;
    expect(reader.user.isInstanceAdmin).toBe(false);
    for (const slug of [hidden, visible]) {
      const project = await t.app.request("/api/projects", {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(project.status).toBe(201);
      const created = Project.parse(await project.json());
      if (slug === hidden) hiddenId = created.id;
      const issue = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ title: "A private card" }),
      });
      expect(issue.status).toBe(201);
      issueNumber = Issue.parse(await issue.json()).number;
    }
    const member = await t.app.request(
      `/api/projects/${visible}/members/${reader.user.id}`,
      {
        method: "PUT",
        headers: admin,
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(member.status).toBe(204);
  });

  afterAll(async () => t.cleanup());

  it.each(["", "/timeline", "/questions", "/revisions", "/comments/999999"])(
    "gives the same reader byte-identical errors and headers for absent and inaccessible projects: %s",
    async (suffix) => {
      for (const number of [issueNumber, 999999]) {
        for (const [missingRef, hiddenRef] of [
          [absent, hidden],
          ["999999", String(hiddenId)],
        ]) {
          const responses = [];
          for (const ref of [missingRef, hiddenRef]) {
            responses.push(
              await observe(
                await t.app.request(
                  `/api/projects/${ref}/issues/${number}${suffix}`,
                  {
                    headers: readerHeaders,
                    redirect: "manual",
                  },
                ),
              ),
            );
          }
          const [missing, inaccessible] = responses;
          expect(missing?.status).toBe(404);
          expect(inaccessible).toEqual(missing);
          expect(missing?.body).toBe(
            '{"error":{"code":"not_found","message":"project not found"}}',
          );
          expect(missing?.redirected).toBe(false);
          expect(missing?.headers).toEqual([
            ["content-type", "application/json"],
            ["vary", "Accept-Encoding"],
          ]);
        }
      }
    },
  );

  it("preserves useful issue and comment errors for a project reader", async () => {
    const request = (suffix: string) =>
      t.app.request(`/api/projects/${visible}/issues/${suffix}`, {
        headers: readerHeaders,
      });
    expect((await request(String(issueNumber))).status).toBe(200);
    const missingIssue = await request("999999");
    expect(missingIssue.status).toBe(404);
    expect(await missingIssue.json()).toEqual({
      error: { code: "not_found", message: "issue not found" },
    });
    const missingComment = await request(`${issueNumber}/comments/999999`);
    expect(missingComment.status).toBe(404);
    expect(await missingComment.json()).toEqual({
      error: { code: "not_found", message: "comment not found" },
    });
  });
});
