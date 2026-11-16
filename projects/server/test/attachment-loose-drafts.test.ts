import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import { attachments, revisions } from "../src/db/project-schema.ts";
import { projects } from "../src/db/system-schema.ts";
import { runHousekeepingTick } from "../src/services/housekeeping.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = { user: { id: number }; headers: Record<string, string> };
type Uploaded = { id: number; filename: string; url: string };

/**
 * A draft uploaded before its card exists: the new-issue page sends the files
 * first and then creates the card with the final body, so the card is born
 * with its attachments and never records an edit.
 */
describe("drafts uploaded before their card", () => {
  let t: TestApp;
  let admin: Record<string, string>;
  let db: Db;
  let projectId: number;
  const slug = "loose";
  const people: Record<"author" | "bystander" | "projectAdmin", Who> =
    {} as never;

  beforeAll(async () => {
    t = await makeTestApp("shared");
    admin = { cookie: await t.login() };
    const jsonHeaders = { ...admin, "content-type": "application/json" };
    await t.app.request("/api/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ slug, name: "Loose" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "an existing card" }),
    });
    const roles = {
      author: "reporter",
      bystander: "writer",
      projectAdmin: "admin",
    } as const;
    for (const [key, role] of Object.entries(roles)) {
      const who = await addUserWithToken(t.ctx, `loose-${key.toLowerCase()}`);
      await t.app.request(`/api/projects/${slug}/members/${who.user.id}`, {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ role }),
      });
      people[key as keyof typeof roles] = who;
    }
    const row = (
      await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
    )[0];
    if (!row) throw new Error("project row missing");
    projectId = row.id;
    db = await t.ctx.router.forProject({
      id: row.id,
      slug,
      database_url: row.databaseUrl,
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function upload(
    who: Record<string, string>,
    name: string,
    opts: { draft?: boolean } = {},
  ): Promise<Response> {
    const form = new FormData();
    form.set("file", new File([`bytes of ${name}`], name));
    if (opts.draft) form.set("draft", "true");
    return t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: who,
      body: form,
    });
  }

  async function loose(
    who: Record<string, string>,
    name: string,
  ): Promise<Uploaded> {
    const res = await upload(who, name, { draft: true });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function create(
    who: Record<string, string>,
    body: string,
    // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
  ): Promise<any> {
    const res = await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: { ...who, "content-type": "application/json" },
      body: JSON.stringify({ title: "with files", body }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function listed(issueNumber: number): Promise<Uploaded[]> {
    return json(
      await t.app.request(
        `/api/projects/${slug}/attachments?issue_number=${issueNumber}`,
        { headers: admin },
      ),
    );
  }

  async function rowOf(id: number) {
    return (
      await db.select().from(attachments).where(eq(attachments.id, id))
    )[0];
  }

  it("attaches the author's draft to the card that links it, with no edit", async () => {
    const shot = await loose(people.author.headers, "shot.png");
    const issue = await create(
      people.author.headers,
      `text ![shot.png](${shot.url})`,
    );

    expect((await listed(issue.number)).map((a) => a.id)).toEqual([shot.id]);
    const timeline = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issue.number}/timeline?limit=50`,
        { headers: admin },
      ),
    );
    expect(
      timeline.items.map((i: { event_type?: string }) => i.event_type),
    ).toEqual(["opened", "attachment_added"]);
    expect(issue.body_edited_at).toBeNull();
    const bodyRevisions = await db
      .select()
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, projectId),
          eq(revisions.subjectType, "issue_body"),
          eq(revisions.subjectId, issue.id),
        ),
      );
    expect(bodyRevisions).toHaveLength(0);
  });

  it("refuses an upload without a card unless it is a draft", async () => {
    const res = await upload(people.author.headers, "plain.txt");
    expect(res.status).toBe(422);
  });

  it("shows the draft to its uploader and to nobody else", async () => {
    const draft = await loose(people.author.headers, "private.png");
    const view = `/api/projects/${slug}/attachments/${draft.id}/view`;

    expect(
      (await t.app.request(draft.url, { headers: people.author.headers }))
        .status,
    ).toBe(200);
    for (const who of [people.bystander, people.projectAdmin]) {
      expect(
        (await t.app.request(draft.url, { headers: who.headers })).status,
      ).toBe(404);
      expect((await t.app.request(view, { headers: who.headers })).status).toBe(
        404,
      );
    }
  });

  it("lets only its uploader delete the draft", async () => {
    const draft = await loose(people.author.headers, "withdrawn.png");
    const remove = (who: Record<string, string>) =>
      t.app.request(`/api/projects/${slug}/attachments/${draft.id}`, {
        method: "DELETE",
        headers: who,
      });
    const references = (who: Record<string, string>) =>
      t.app.request(
        `/api/projects/${slug}/attachments/${draft.id}/references`,
        {
          headers: who,
        },
      );

    // A writer may delete anyone's attachment, but not one it cannot see.
    expect((await remove(people.bystander.headers)).status).toBe(404);
    expect((await references(people.bystander.headers)).status).toBe(404);
    expect((await references(people.author.headers)).status).toBe(200);
    expect((await remove(people.author.headers)).status).toBe(204);
    expect(
      (await t.app.request(draft.url, { headers: people.author.headers }))
        .status,
    ).toBe(404);
  });

  it("does not attach somebody else's draft to the author's card", async () => {
    const theirs = await loose(people.bystander.headers, "theirs.png");
    const issue = await create(people.author.headers, `![](${theirs.url})`);

    expect((await listed(issue.number)).map((a) => a.id)).not.toContain(
      theirs.id,
    );
    const row = await rowOf(theirs.id);
    expect(row?.issueId).toBeNull();
    expect(row?.draft).toBe(true);
  });

  it("renames a name taken by another file of the same card, in the body too", async () => {
    const first = await loose(people.author.headers, "shot.png");
    const second = await loose(people.author.headers, "shot.png");
    const renamed = `shot-${second.id}.png`;
    const issue = await create(
      people.author.headers,
      `![shot.png](${first.url}) ![shot.png](${second.url})`,
    );

    expect((await listed(issue.number)).map((a) => a.filename).sort()).toEqual(
      ["shot.png", renamed].sort(),
    );
    // A stored body addresses attachments by project id.
    const stored = (url: string) =>
      url.replace(`/api/projects/${slug}/`, `/api/projects/${projectId}/`);
    const secondUrl = second.url.replace(/shot\.png$/, renamed);
    expect(issue.body).toBe(
      `![shot.png](${stored(first.url)}) ![${renamed}](${stored(secondUrl)})`,
    );
  });

  it("leaves a draft loose when a comment links it", async () => {
    const draft = await loose(people.author.headers, "in-comment.png");
    const res = await t.app.request(`/api/projects/${slug}/issues/1/comments`, {
      method: "POST",
      headers: { ...people.author.headers, "content-type": "application/json" },
      body: JSON.stringify({ body: `see ![](${draft.url})` }),
    });
    expect(res.status).toBe(201);

    const row = await rowOf(draft.id);
    expect(row?.issueId).toBeNull();
    expect(row?.draft).toBe(true);
  });

  it("reaps a draft that no card claimed within a day", async () => {
    const stale = await loose(people.author.headers, "forgotten.png");
    await db
      .update(attachments)
      .set({ createdAt: new Date(Date.now() - 48 * 3600 * 1000) })
      .where(eq(attachments.id, stale.id));

    await runHousekeepingTick(t.ctx);

    expect(await rowOf(stale.id)).toBeUndefined();
  });
});
