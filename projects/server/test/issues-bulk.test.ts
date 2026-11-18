import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe.each(PLACEMENTS)("bulk issue commands (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let me: { id: number; login: string };
  let statuses: { id: number; name: string }[];
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    slug = `bulk-${placement.replaceAll(/[^a-z]/g, "")}`;
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Bulk" }),
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

  async function createIssue(title: string, extra: object = {}) {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title, ...extra }),
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

  const bulk = (body: unknown, who: Record<string, string> = { cookie }) =>
    t.app.request(`/api/projects/${slug}/issues/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json", ...who },
      body: JSON.stringify(body),
    });

  const issue = async (number: number) =>
    json(
      await t.app.request(`/api/projects/${slug}/issues/${number}`, {
        headers: { cookie },
      }),
    );

  async function eventTypes(number: number): Promise<string[]> {
    const page = await json(
      await t.app.request(`/api/projects/${slug}/issues/${number}/timeline`, {
        headers: { cookie },
      }),
    );
    return page.items
      .filter((i: { type: string }) => i.type === "event")
      .map((i: { event_type: string }) => i.event_type);
  }

  it("adds a label to every card, recording it only where it was missing", async () => {
    const x = await createLabel(`x-${placement}`);
    const a = await createIssue("a");
    const b = await createIssue("b", { label_ids: [x.id] });
    const c = await createIssue("c");

    const res = await bulk({
      numbers: [c.number, a.number, b.number, a.number],
      commands: [{ type: "label_add", label_id: x.id }],
    });
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.issues.map((i: { number: number }) => i.number)).toEqual([
      c.number,
      a.number,
      b.number,
    ]);
    expect(result.issues[0].body).toBeUndefined();

    for (const n of [a.number, b.number, c.number]) {
      const labels = (await issue(n)).labels.map((l: { id: number }) => l.id);
      expect(labels).toEqual([x.id]);
    }
    expect(await eventTypes(a.number)).toContain("label_added");
    expect(await eventTypes(c.number)).toContain("label_added");
    expect(await eventTypes(b.number)).not.toContain("label_added");
  });

  it("is incremental: another label already on a card survives", async () => {
    const x = await createLabel(`keep-${placement}`);
    const y = await createLabel(`add-${placement}`);
    const a = await createIssue("keeps x", { label_ids: [x.id] });

    const res = await bulk({
      numbers: [a.number],
      commands: [{ type: "label_add", label_id: y.id }],
    });
    expect(res.status).toBe(200);
    const ids = (await issue(a.number)).labels.map((l: { id: number }) => l.id);
    expect(ids.sort()).toEqual([x.id, y.id].sort());
  });

  it("removes labels, assigns and unassigns", async () => {
    const x = await createLabel(`drop-${placement}`);
    const a = await createIssue("a", { label_ids: [x.id] });
    const b = await createIssue("b");

    let res = await bulk({
      numbers: [a.number, b.number],
      commands: [
        { type: "label_remove", label_id: x.id },
        { type: "assign", user_id: me.id },
      ],
    });
    expect(res.status).toBe(200);
    for (const n of [a.number, b.number]) {
      const after = await issue(n);
      expect(after.labels).toEqual([]);
      expect(after.assignees.map((u: { id: number }) => u.id)).toEqual([me.id]);
    }
    expect(await eventTypes(a.number)).toContain("label_removed");
    expect(await eventTypes(b.number)).not.toContain("label_removed");

    res = await bulk({
      numbers: [a.number, b.number],
      commands: [{ type: "unassign", user_id: me.id }],
    });
    expect(res.status).toBe(200);
    expect((await issue(a.number)).assignees).toEqual([]);
    expect(await eventTypes(b.number)).toContain("unassigned");
  });

  it("moves status on every card", async () => {
    const done = statusNamed("Done");
    const a = await createIssue("a");
    const b = await createIssue("b");
    const res = await bulk({
      numbers: [a.number, b.number],
      commands: [{ type: "status", status_id: done.id }],
    });
    expect(res.status).toBe(200);
    expect((await issue(a.number)).status.id).toBe(done.id);
    expect((await issue(b.number)).status.id).toBe(done.id);
  });

  it("writes nothing when one card is missing", async () => {
    const x = await createLabel(`never-${placement}`);
    const a = await createIssue("stays bare");
    const res = await bulk({
      numbers: [a.number, 99_998, 99_999],
      commands: [{ type: "label_add", label_id: x.id }],
    });
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toBe(
      "issues not found: 99998, 99999",
    );
    expect((await issue(a.number)).labels).toEqual([]);
    expect(await eventTypes(a.number)).not.toContain("label_added");
  });

  it("writes nothing when one card is in the trash", async () => {
    const x = await createLabel(`trash-${placement}`);
    const a = await createIssue("stays bare");
    const gone = await createIssue("trashed");
    const del = await t.app.request(
      `/api/projects/${slug}/issues/${gone.number}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(del.status).toBe(204);

    const res = await bulk({
      numbers: [a.number, gone.number],
      commands: [{ type: "label_add", label_id: x.id }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await issue(a.number)).labels).toEqual([]);
  });

  it("writes nothing when a command names an unknown id", async () => {
    const a = await createIssue("stays bare");
    const res = await bulk({
      numbers: [a.number],
      commands: [
        { type: "assign", user_id: me.id },
        { type: "label_add", label_id: 999_999 },
      ],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toBe(
      "command[1]: unknown label_id",
    );
    expect((await issue(a.number)).assignees).toEqual([]);
  });

  it("refuses comments_hide", async () => {
    const a = await createIssue("no hiding here");
    const res = await bulk({
      numbers: [a.number],
      commands: [{ type: "comments_hide", hidden: true, comment_ids: [1] }],
    });
    expect(res.status).toBe(422);
  });

  it("requires writer", async () => {
    const a = await createIssue("gate");
    const payload = {
      numbers: [a.number],
      commands: [{ type: "assign", user_id: me.id }],
    };
    const reporter = await addUserWithToken(
      t.ctx,
      `bulk-reporter-${placement}`,
    );
    await t.app.request(`/api/projects/${slug}/members/${reporter.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "reporter" }),
    });
    expect((await bulk(payload, reporter.headers)).status).toBe(403);
    expect((await issue(a.number)).assignees).toEqual([]);

    const writer = await addUserWithToken(t.ctx, `bulk-writer-${placement}`);
    await t.app.request(`/api/projects/${slug}/members/${writer.user.id}`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ role: "writer" }),
    });
    expect((await bulk(payload, writer.headers)).status).toBe(200);
  });
});
