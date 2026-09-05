import type { MemberRole } from "@todou/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Member = { headers: { authorization: string }; id: number };

/**
 * One placement is enough: every gate here reads `project_members` out of the
 * system tier, which no placement mode moves.
 */
describe("the reporter role", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "reporter-role";
  const admin = () => ({ "content-type": "application/json", cookie });

  const members: Record<"reader" | "reporter" | "writer", Member> = {
    reader: { headers: { authorization: "" }, id: 0 },
    reporter: { headers: { authorization: "" }, id: 0 },
    writer: { headers: { authorization: "" }, id: 0 },
  };

  const as = (who: keyof typeof members) => ({
    "content-type": "application/json",
    ...members[who].headers,
  });

  /** An issue opened by `who`, returning its number. */
  async function openIssue(
    who: keyof typeof members | "admin",
    title: string,
  ): Promise<number> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: who === "admin" ? admin() : as(who),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)).number as number;
  }

  async function comment(
    who: keyof typeof members | "admin",
    issue: number,
    body: string,
  ): Promise<number> {
    const res = await t.app.request(
      `/api/projects/${slug}/issues/${issue}/comments`,
      {
        method: "POST",
        headers: who === "admin" ? admin() : as(who),
        body: JSON.stringify({ body }),
      },
    );
    expect(res.status).toBe(201);
    return (await json(res)).id as number;
  }

  function upload(who: keyof typeof members, issue: number) {
    const form = new FormData();
    form.set("file", new File(["screenshot"], "shot.txt"));
    form.set("issue_number", String(issue));
    return t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: members[who].headers,
      body: form,
    });
  }

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ slug, name: "Reporter role" }),
    });
    expect(created.status).toBe(201);

    for (const role of ["reader", "reporter", "writer"] as const) {
      const added = await addUserWithToken(t.ctx, `${role}-of-${slug}`);
      const res = await t.app.request(
        `/api/projects/${slug}/members/${added.user.id}`,
        {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ role: role satisfies MemberRole }),
        },
      );
      expect(res.status).toBe(204);
      members[role] = { headers: added.headers, id: added.user.id };
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe("what a reporter gains over a reader", () => {
    it("opens issues", async () => {
      const res = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: as("reporter"),
        body: JSON.stringify({ title: "found a bug" }),
      });
      expect(res.status).toBe(201);
    });

    it("comments on someone else's issue", async () => {
      const issue = await openIssue("admin", "not mine");
      const res = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments`,
        {
          method: "POST",
          headers: as("reporter"),
          body: JSON.stringify({ body: "same here" }),
        },
      );
      expect(res.status).toBe(201);
    });

    it("attaches a file", async () => {
      const issue = await openIssue("reporter", "with a screenshot");
      expect((await upload("reporter", issue)).status).toBe(201);
    });
  });

  describe("what a reporter may not set while opening an issue", () => {
    /** POST with `extra` merged into a valid body. */
    const open = (who: keyof typeof members, extra: object) =>
      t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: as(who),
        body: JSON.stringify({ title: "opened with extras", ...extra }),
      });

    it("refuses a status, and says which capability is missing", async () => {
      const statuses = await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: as("reporter"),
        }),
      );
      const res = await open("reporter", { status_id: statuses[1].id });
      expect(res.status).toBe(403);
      expect((await json(res)).error.message).toMatch(/issue\.triage/);
    });

    it("refuses labels", async () => {
      const label = await json(
        await t.app.request(`/api/projects/${slug}/labels`, {
          method: "POST",
          headers: admin(),
          body: JSON.stringify({ name: "for-the-create-gate" }),
        }),
      );
      expect((await open("reporter", { label_ids: [label.id] })).status).toBe(
        403,
      );
    });

    it("refuses assignees", async () => {
      const res = await open("reporter", {
        assignee_ids: [members.reporter.id],
      });
      expect(res.status).toBe(403);
    });

    it("refuses before it validates the ids, so the role is what it names", async () => {
      // A label that does not exist would be a 422 on its own; the point is
      // that the role is decided first.
      const res = await open("reporter", { label_ids: [999_999] });
      expect(res.status).toBe(403);
    });

    it("takes the empty arrays every client sends by default", async () => {
      const res = await open("reporter", { label_ids: [], assignee_ids: [] });
      expect(res.status).toBe(201);
    });

    it("lands the issue in the project's default status", async () => {
      const statuses = await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: as("reporter"),
        }),
      );
      const fallback = statuses.find(
        (s: { is_default: boolean }) => s.is_default,
      );
      const created = await json(await open("reporter", {}));
      expect(created.status.id).toBe(fallback.id);
    });

    it("still lets a writer open an issue with all three", async () => {
      const statuses = await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: as("writer"),
        }),
      );
      const label = await json(
        await t.app.request(`/api/projects/${slug}/labels`, {
          method: "POST",
          headers: as("writer"),
          body: JSON.stringify({ name: "writer-may" }),
        }),
      );
      const res = await open("writer", {
        status_id: statuses[1].id,
        label_ids: [label.id],
        assignee_ids: [members.writer.id],
      });
      expect(res.status).toBe(201);
      const created = await json(res);
      expect(created.status.id).toBe(statuses[1].id);
      expect(created.labels).toHaveLength(1);
      expect(created.assignees).toHaveLength(1);
    });
  });

  describe("what a reporter may change", () => {
    it("edits the title and body of its own issue", async () => {
      const issue = await openIssue("reporter", "typo in the titel");
      const res = await t.app.request(`/api/projects/${slug}/issues/${issue}`, {
        method: "PATCH",
        headers: as("reporter"),
        body: JSON.stringify({ title: "typo in the title", body: "fixed" }),
      });
      expect(res.status).toBe(200);
      expect((await json(res)).title).toBe("typo in the title");
    });

    it("cannot move its own issue to another status", async () => {
      const issue = await openIssue("reporter", "mine to write, not to sort");
      const statuses = await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: as("reporter"),
        }),
      );
      const res = await t.app.request(`/api/projects/${slug}/issues/${issue}`, {
        method: "PATCH",
        headers: as("reporter"),
        body: JSON.stringify({ status_id: statuses[1].id }),
      });
      expect(res.status).toBe(403);
      expect((await json(res)).error.message).toMatch(/issue\.triage/);
    });

    it("cannot label or assign its own issue", async () => {
      const issue = await openIssue("reporter", "still not mine to triage");
      for (const patch of [{ label_ids: [] }, { assignee_ids: [] }]) {
        const res = await t.app.request(
          `/api/projects/${slug}/issues/${issue}`,
          {
            method: "PATCH",
            headers: as("reporter"),
            body: JSON.stringify(patch),
          },
        );
        expect(res.status).toBe(403);
      }
    });

    it("cannot retitle someone else's issue", async () => {
      const issue = await openIssue("admin", "not the reporter's");
      const res = await t.app.request(`/api/projects/${slug}/issues/${issue}`, {
        method: "PATCH",
        headers: as("reporter"),
        body: JSON.stringify({ title: "hijacked" }),
      });
      expect(res.status).toBe(403);
    });

    it("edits and deletes its own comment, but not someone else's", async () => {
      const issue = await openIssue("admin", "a thread");
      const mine = await comment("reporter", issue, "mine");
      const theirs = await comment("admin", issue, "theirs");

      const edited = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments/${mine}`,
        {
          method: "PATCH",
          headers: as("reporter"),
          body: JSON.stringify({ body: "mine, corrected" }),
        },
      );
      expect(edited.status).toBe(200);

      const foreign = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments/${theirs}`,
        {
          method: "PATCH",
          headers: as("reporter"),
          body: JSON.stringify({ body: "not mine" }),
        },
      );
      expect(foreign.status).toBe(403);

      const removed = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments/${mine}`,
        { method: "DELETE", headers: as("reporter") },
      );
      expect(removed.status).toBe(204);
    });

    it("trashes its own issue, but not someone else's", async () => {
      const mine = await openIssue("reporter", "withdrawn");
      const theirs = await openIssue("admin", "not withdrawable");

      const own = await t.app.request(`/api/projects/${slug}/issues/${mine}`, {
        method: "DELETE",
        headers: as("reporter"),
      });
      expect(own.status).toBe(204);

      const foreign = await t.app.request(
        `/api/projects/${slug}/issues/${theirs}`,
        { method: "DELETE", headers: as("reporter") },
      );
      expect(foreign.status).toBe(403);
    });
  });

  describe("what stays out of a reporter's reach", () => {
    it("refuses field commands, answers, spec writes and moves", async () => {
      const issue = await openIssue("reporter", "the limits of reporting");
      const question = await comment("admin", issue, "a plain comment");

      const commands = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/commands`,
        {
          method: "POST",
          headers: as("reporter"),
          body: JSON.stringify({ body: "closing", commands: [] }),
        },
      );
      expect(commands.status).toBe(403);

      const answers = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments/${question}/answers`,
        {
          method: "POST",
          headers: as("reporter"),
          body: JSON.stringify({ answers: [{ key: "q1", declined: true }] }),
        },
      );
      expect(answers.status).toBe(403);

      const spec = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/spec/push`,
        {
          method: "POST",
          headers: as("reporter"),
          body: JSON.stringify({
            files: [{ path: "plan.md", body: "not mine to write" }],
            message: "v1",
          }),
        },
      );
      expect(spec.status).toBe(403);

      const moved = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/move`,
        {
          method: "POST",
          headers: as("reporter"),
          body: JSON.stringify({ to_project: "elsewhere" }),
        },
      );
      expect(moved.status).toBe(403);
    });

    it("refuses the label catalog", async () => {
      const res = await t.app.request(`/api/projects/${slug}/labels`, {
        method: "POST",
        headers: as("reporter"),
        body: JSON.stringify({ name: "wontfix" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("a reader is unchanged", () => {
    it("still cannot open, comment on or attach to anything", async () => {
      const issue = await openIssue("admin", "readable only");

      const opened = await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: as("reader"),
        body: JSON.stringify({ title: "not allowed" }),
      });
      expect(opened.status).toBe(403);

      const commented = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/comments`,
        {
          method: "POST",
          headers: as("reader"),
          body: JSON.stringify({ body: "not allowed" }),
        },
      );
      expect(commented.status).toBe(403);

      expect((await upload("reader", issue)).status).toBe(403);
    });

    it("still cannot edit its own issue, having none", async () => {
      const issue = await openIssue("admin", "reader cannot patch");
      const res = await t.app.request(`/api/projects/${slug}/issues/${issue}`, {
        method: "PATCH",
        headers: as("reader"),
        body: JSON.stringify({ title: "not allowed" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("a writer keeps everything it had", () => {
    it("triages any issue, its own or not", async () => {
      const issue = await openIssue("admin", "writer may sort this");
      const statuses = await json(
        await t.app.request(`/api/projects/${slug}/statuses`, {
          headers: as("writer"),
        }),
      );
      const res = await t.app.request(`/api/projects/${slug}/issues/${issue}`, {
        method: "PATCH",
        headers: as("writer"),
        body: JSON.stringify({
          status_id: statuses[1].id,
          title: "writer may sort and retitle this",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("comments, attaches and pushes a spec", async () => {
      const issue = await openIssue("writer", "writer's own");
      await comment("writer", issue, "still fine");
      expect((await upload("writer", issue)).status).toBe(201);

      const spec = await t.app.request(
        `/api/projects/${slug}/issues/${issue}/spec/push`,
        {
          method: "POST",
          headers: as("writer"),
          body: JSON.stringify({
            files: [{ path: "plan.md", body: "hello" }],
            message: "v1",
          }),
        },
      );
      expect(spec.status).toBe(200);
    });
  });
});
