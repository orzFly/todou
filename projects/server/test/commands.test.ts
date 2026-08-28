import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe.each(PLACEMENTS)("issue commands (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let me: { id: number; login: string };
  let statuses: { id: number; name: string; category: string }[];
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    slug = `cmds-${placement.replaceAll(/[^a-z]/g, "")}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Commands" }),
    });
    expect(res.status).toBe(201);
    me = await json(await t.app.request("/api/me", { headers: { cookie } }));
    statuses = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: { cookie },
      }),
    );
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const statusNamed = (name: string) => {
    const found = statuses.find((s) => s.name === name);
    if (!found) throw new Error(`no status ${name}`);
    return found;
  };

  async function createIssue(title: string) {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function createLabel(name: string) {
    const res = await t.app.request(`/api/projects/${slug}/labels`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name, color: "#ff0000" }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  const submit = (
    number: number,
    body: unknown,
    who: Record<string, string> = { cookie },
  ) =>
    t.app.request(`/api/projects/${slug}/issues/${number}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify(body),
    });

  async function timelineOf(number: number, qs = "") {
    return json(
      await t.app.request(
        `/api/projects/${slug}/issues/${number}/timeline${qs}`,
        { headers: { cookie } },
      ),
    );
  }

  it("lands the comment and the status change together", async () => {
    const issue = await createIssue("Comment and close");
    const done = statusNamed("Done");
    const res = await submit(issue.number, {
      body: "shipping this",
      commands: [{ type: "status", status_id: done.id }],
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.comment.body).toBe("shipping this");
    expect(result.issue.status.id).toBe(done.id);

    const timeline = await timelineOf(issue.number);
    expect(
      timeline.items.map((i: { type: string; event_type?: string }) =>
        i.type === "event" ? i.event_type : "comment",
      ),
    ).toEqual(["opened", "comment", "closed"]);
  });

  it("rolls the comment back when a command is invalid", async () => {
    const issue = await createIssue("Atomic failure");
    const before = await timelineOf(issue.number);
    const res = await submit(issue.number, {
      body: "should never land",
      commands: [{ type: "label_add", label_id: 999_999 }],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toBe(
      "command[0]: unknown label_id",
    );

    const after = await timelineOf(issue.number);
    expect(after.items).toHaveLength(before.items.length);
    const issueAfter = await json(
      await t.app.request(`/api/projects/${slug}/issues/${issue.number}`, {
        headers: { cookie },
      }),
    );
    expect(issueAfter.labels).toEqual([]);
  });

  it("points at the offending command by index", async () => {
    const issue = await createIssue("Indexed errors");
    const done = statusNamed("Done");
    const res = await submit(issue.number, {
      body: "",
      commands: [
        { type: "status", status_id: done.id },
        { type: "status", status_id: 999_999 },
      ],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toBe(
      "command[1]: unknown status_id",
    );
    const issueAfter = await json(
      await t.app.request(`/api/projects/${slug}/issues/${issue.number}`, {
        headers: { cookie },
      }),
    );
    expect(issueAfter.status.name).toBe("Todo");
  });

  it("accepts commands with no body at all", async () => {
    const issue = await createIssue("Commands only");
    const progress = statusNamed("In Progress");
    const res = await submit(issue.number, {
      body: "",
      commands: [
        { type: "status", status_id: progress.id },
        { type: "assign", user_id: me.id },
      ],
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.comment).toBeNull();
    expect(result.issue.status.id).toBe(progress.id);
    expect(result.issue.assignees.map((a: { id: number }) => a.id)).toEqual([
      me.id,
    ]);

    const timeline = await timelineOf(issue.number);
    expect(
      timeline.items.map((i: { event_type?: string }) => i.event_type),
    ).toEqual(["opened", "status_changed", "assigned"]);
  });

  it("takes a body with no commands, like the plain comment path", async () => {
    const issue = await createIssue("Body only");
    const res = await submit(issue.number, {
      body: "just talking",
      commands: [],
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.comment.body).toBe("just talking");

    const timeline = await timelineOf(issue.number);
    expect(timeline.items.map((i: { type: string }) => i.type)).toEqual([
      "event",
      "comment",
    ]);
  });

  it("rejects a submission that is empty on both sides", async () => {
    const issue = await createIssue("Nothing at all");
    expect(
      (await submit(issue.number, { body: "", commands: [] })).status,
    ).toBe(422);
  });

  it("adds a label without dropping labels someone else added", async () => {
    const issue = await createIssue("Incremental labels");
    const mine = await createLabel(`mine-${placement}`);
    const theirs = await createLabel(`theirs-${placement}`);
    // Someone else's label is already on the card; an incremental add must
    // not compile into a whole-set replacement that drops it.
    await t.app.request(`/api/projects/${slug}/issues/${issue.number}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ label_ids: [theirs.id] }),
    });

    const res = await submit(issue.number, {
      body: "",
      commands: [{ type: "label_add", label_id: mine.id }],
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.issue.labels.map((l: { id: number }) => l.id).sort()).toEqual(
      [mine.id, theirs.id].sort(),
    );

    const removed = await submit(issue.number, {
      body: "",
      commands: [{ type: "label_remove", label_id: mine.id }],
    });
    expect(
      (await json(removed)).issue.labels.map((l: { id: number }) => l.id),
    ).toEqual([theirs.id]);
  });

  it("treats an already-true command as a successful no-op", async () => {
    const issue = await createIssue("Idempotent commands");
    const label = await createLabel(`idem-${placement}`);
    const progress = statusNamed("In Progress");
    const first = await submit(issue.number, {
      body: "",
      commands: [
        { type: "status", status_id: progress.id },
        { type: "label_add", label_id: label.id },
        { type: "assign", user_id: me.id },
      ],
    });
    expect(first.status).toBe(200);
    const before = await timelineOf(issue.number);

    const again = await submit(issue.number, {
      body: "",
      commands: [
        { type: "status", status_id: progress.id },
        { type: "label_add", label_id: label.id },
        { type: "assign", user_id: me.id },
        { type: "unassign", user_id: me.id },
        { type: "assign", user_id: me.id },
      ],
    });
    expect(again.status).toBe(200);
    const after = await timelineOf(issue.number);
    // Only the unassign/assign pair had anything to do.
    expect(after.items.length).toBe(before.items.length + 2);
    expect(
      (await json(again)).issue.assignees.map((a: { id: number }) => a.id),
    ).toEqual([me.id]);
  });

  it("applies repeated status commands in order, closing last", async () => {
    const issue = await createIssue("Two status commands");
    const progress = statusNamed("In Progress");
    const done = statusNamed("Done");
    const res = await submit(issue.number, {
      body: "",
      commands: [
        { type: "status", status_id: progress.id },
        { type: "status", status_id: done.id },
      ],
    });
    expect(res.status).toBe(200);
    expect((await json(res)).issue.status.id).toBe(done.id);
    const timeline = await timelineOf(issue.number);
    expect(
      timeline.items.map((i: { event_type?: string }) => i.event_type),
    ).toEqual(["opened", "status_changed", "closed"]);
  });

  it("records reopened when a command moves a closed card back", async () => {
    const issue = await createIssue("Reopen by command");
    const done = statusNamed("Done");
    const todo = statusNamed("Todo");
    await submit(issue.number, {
      body: "",
      commands: [{ type: "status", status_id: done.id }],
    });
    await submit(issue.number, {
      body: "",
      commands: [{ type: "status", status_id: todo.id }],
    });
    const timeline = await timelineOf(issue.number);
    expect(
      timeline.items.map((i: { event_type?: string }) => i.event_type),
    ).toEqual(["opened", "closed", "reopened"]);
  });

  it("scans references in the command submission's body", async () => {
    const target = await createIssue("Referenced by a command comment");
    const issue = await createIssue("Referencing card");
    const done = statusNamed("Done");
    const res = await submit(issue.number, {
      body: `fixed alongside #${target.number}`,
      commands: [{ type: "status", status_id: done.id }],
    });
    expect(res.status).toBe(200);
    const timeline = await timelineOf(target.number);
    expect(
      timeline.items.some(
        (i: { event_type?: string }) => i.event_type === "referenced",
      ),
    ).toBe(true);
  });

  it("requires writer, and hides the project from non-members", async () => {
    const issue = await createIssue("Permission gate");
    const done = statusNamed("Done");
    const payload = {
      body: "",
      commands: [{ type: "status", status_id: done.id }],
    };

    const reader = await addUserWithToken(t.ctx, `cmd-reader-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${reader.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "reader" }),
    });
    expect((await submit(issue.number, payload, reader.headers)).status).toBe(
      403,
    );

    const stranger = await addUserWithToken(t.ctx, `cmd-outsider-${placement}`);
    expect((await submit(issue.number, payload, stranger.headers)).status).toBe(
      404,
    );

    const writer = await addUserWithToken(t.ctx, `cmd-writer-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${writer.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });
    expect((await submit(issue.number, payload, writer.headers)).status).toBe(
      200,
    );
  });

  it("refuses to assign someone who is not a project member", async () => {
    const issue = await createIssue("Assign an outsider");
    const outsider = await addUserWithToken(
      t.ctx,
      `cmd-nonmember-${placement}`,
    );
    const res = await submit(issue.number, {
      body: "",
      commands: [{ type: "assign", user_id: outsider.user.id }],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toBe(
      "command[0]: user_id must be a project member",
    );
  });

  it("404s on an unknown issue", async () => {
    const done = statusNamed("Done");
    expect(
      (
        await submit(9999, {
          body: "",
          commands: [{ type: "status", status_id: done.id }],
        })
      ).status,
    ).toBe(404);
  });

  it("publishes the comment first, its events next, the issue last", async () => {
    const issue = await createIssue("SSE order");
    const done = statusNamed("Done");
    const seen: { entity: string; action: string }[] = [];
    const unsubscribe = t.ctx.bus.subscribe((_projectId, event) => {
      if (event.issue_number === issue.number) {
        seen.push({ entity: event.entity, action: event.action });
      }
    });
    try {
      expect(
        (
          await submit(issue.number, {
            body: "closing",
            commands: [{ type: "status", status_id: done.id }],
          })
        ).status,
      ).toBe(200);
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual([
      { entity: "timeline", action: "created" },
      { entity: "timeline", action: "created" },
      { entity: "issue", action: "updated" },
    ]);
  });
});
