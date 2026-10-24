import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import { attachments } from "../src/db/project-schema.ts";
import { draftAttachmentMarks, projects } from "../src/db/system-schema.ts";
import { runHousekeepingTick } from "../src/services/housekeeping.ts";
import { reapDraftAttachments } from "../src/services/storage-admin.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = { user: { id: number }; headers: Record<string, string> };
type Uploaded = { id: number; filename: string; url: string };

/**
 * T-567: who may delete a file, what deleting it leaves behind, and what the
 * confirmation is told. T-568: a file an editor uploads before its text is
 * sent stays a draft until that text links it.
 */
describe("deleting attachments (T-567) and drafts (T-568)", () => {
  let t: TestApp;
  let admin: Record<string, string>;
  let db: Db;
  let projectId: number;
  const slug = "del";
  const people: Record<
    "uploader" | "otherReporter" | "writer" | "projectAdmin",
    Who
  > = {} as never;

  const issueNumber = 1;

  beforeAll(async () => {
    t = await makeTestApp("shared");
    admin = { cookie: await t.login() };
    const jsonHeaders = { ...admin, "content-type": "application/json" };
    await t.app.request("/api/projects", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ slug, name: "Delete" }),
    });
    for (const title of ["files", "neighbour", "binned"]) {
      await t.app.request(`/api/projects/${slug}/issues`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ title }),
      });
    }
    const roles = {
      uploader: "reporter",
      otherReporter: "reporter",
      writer: "writer",
      projectAdmin: "admin",
    } as const;
    for (const [key, role] of Object.entries(roles)) {
      const who = await addUserWithToken(t.ctx, `del-${key.toLowerCase()}`);
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
    opts: { draft?: boolean; issue?: number } = {},
  ): Promise<Uploaded> {
    const form = new FormData();
    form.set("file", new File([`bytes of ${name}`], name));
    form.set("issue_number", String(opts.issue ?? issueNumber));
    if (opts.draft) form.set("draft", "true");
    const res = await t.app.request(`/api/projects/${slug}/attachments`, {
      method: "POST",
      headers: who,
      body: form,
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  const remove = (who: Record<string, string>, id: number) =>
    t.app.request(`/api/projects/${slug}/attachments/${id}`, {
      method: "DELETE",
      headers: who,
    });

  const comment = (who: Record<string, string>, body: string, issue = 1) =>
    t.app.request(`/api/projects/${slug}/issues/${issue}/comments`, {
      method: "POST",
      headers: { ...who, "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });

  async function listed(): Promise<number[]> {
    const list = await json(
      await t.app.request(
        `/api/projects/${slug}/attachments?issue_number=${issueNumber}`,
        { headers: admin },
      ),
    );
    return list.map((a: { id: number }) => a.id);
  }

  async function eventsOf(type: string): Promise<{ payload: unknown }[]> {
    const page = await json(
      await t.app.request(
        `/api/projects/${slug}/issues/${issueNumber}/timeline?limit=100`,
        { headers: admin },
      ),
    );
    return page.items.filter(
      (i: { type: string; event_type?: string }) =>
        i.type === "event" && i.event_type === type,
    );
  }

  async function storageKeyOf(id: number): Promise<string> {
    const row = (
      await db.select().from(attachments).where(eq(attachments.id, id))
    )[0];
    if (!row) throw new Error(`attachment ${id} has no row`);
    return row.storageKey;
  }

  describe("who may delete", () => {
    it("lets the uploader delete their own file, object and all", async () => {
      const file = await upload(people.uploader.headers, "mine.txt");
      const key = await storageKeyOf(file.id);
      expect(await t.ctx.storage.head(key)).not.toBeNull();

      const res = await remove(people.uploader.headers, file.id);
      expect(res.status).toBe(204);

      expect(await listed()).not.toContain(file.id);
      expect(await t.ctx.storage.head(key)).toBeNull();
      const download = await t.app.request(file.url, { headers: admin });
      expect(download.status).toBe(404);
      const again = await remove(people.uploader.headers, file.id);
      expect(again.status).toBe(404);
    });

    it("refuses a reporter deleting someone else's file with 403", async () => {
      const file = await upload(people.uploader.headers, "theirs.txt");
      const key = await storageKeyOf(file.id);

      const res = await remove(people.otherReporter.headers, file.id);
      expect(res.status).toBe(403);
      expect((await json(res)).error.code).toBe("forbidden");

      expect(await listed()).toContain(file.id);
      expect(await t.ctx.storage.head(key)).not.toBeNull();
    });

    it("refuses an uploader who has since become a reader", async () => {
      const demoted = await addUserWithToken(t.ctx, "del-demoted");
      const setRole = (role: string) =>
        t.app.request(`/api/projects/${slug}/members/${demoted.user.id}`, {
          method: "PUT",
          headers: { ...admin, "content-type": "application/json" },
          body: JSON.stringify({ role }),
        });
      await setRole("reporter");
      const file = await upload(demoted.headers, "before-demotion.txt");
      await setRole("reader");

      const res = await remove(demoted.headers, file.id);
      expect(res.status).toBe(403);
      expect(await listed()).toContain(file.id);
    });

    it("answers a non-member with 404", async () => {
      const file = await upload(people.uploader.headers, "outsider.txt");
      const outsider = await addUserWithToken(t.ctx, "del-outsider");
      const res = await remove(outsider.headers, file.id);
      expect(res.status).toBe(404);
      expect(await listed()).toContain(file.id);
    });

    it("lets a writer delete anyone's file", async () => {
      const file = await upload(people.uploader.headers, "for-writer.txt");
      const res = await remove(people.writer.headers, file.id);
      expect(res.status).toBe(204);
      expect(await listed()).not.toContain(file.id);
    });

    it("lets a project admin delete anyone's file", async () => {
      const file = await upload(people.uploader.headers, "for-admin.txt");
      const res = await remove(people.projectAdmin.headers, file.id);
      expect(res.status).toBe(204);
      expect(await listed()).not.toContain(file.id);
    });
  });

  describe("what a deletion leaves on the card", () => {
    it("records attachment_deleted with the actor and the name", async () => {
      const file = await upload(people.uploader.headers, "recorded.txt");
      await remove(people.writer.headers, file.id);

      const deleted = await eventsOf("attachment_deleted");
      const mine = deleted.find(
        (e) =>
          (e.payload as { attachment: { id: number } }).attachment.id ===
          file.id,
      ) as { actor: { login: string }; payload: unknown } | undefined;
      expect(mine?.actor.login).toBe("del-writer");
      expect(mine?.payload).toMatchObject({
        attachment: { id: file.id, filename: "recorded.txt" },
      });

      const list = await json(
        await t.app.request(
          `/api/projects/${slug}/attachments/deleted?issue_number=${issueNumber}`,
          { headers: people.otherReporter.headers },
        ),
      );
      expect(list).toContainEqual(
        expect.objectContaining({
          id: file.id,
          filename: "recorded.txt",
          deleted_by: expect.objectContaining({ login: "del-writer" }),
        }),
      );
    });

    it("keeps the attachment_added event that came before it", async () => {
      const file = await upload(people.uploader.headers, "kept-event.txt");
      expect((await remove(people.uploader.headers, file.id)).status).toBe(204);
      const added = await eventsOf("attachment_added");
      expect(
        added.some(
          (e) =>
            (e.payload as { attachment: { id: number } }).attachment.id ===
            file.id,
        ),
      ).toBe(true);
    });

    it("refuses with 409 while the card is in the trash", async () => {
      const file = await upload(people.uploader.headers, "binned.txt", {
        issue: 3,
      });
      await t.app.request(`/api/projects/${slug}/issues/3`, {
        method: "DELETE",
        headers: admin,
      });
      const res = await remove(admin, file.id);
      expect(res.status).toBe(409);
      await t.app.request(`/api/projects/${slug}/issues/3/restore`, {
        method: "POST",
        headers: admin,
      });
    });
  });

  describe("references the confirmation lists", () => {
    it("lists the bodies and comments that link the file, and nothing else", async () => {
      const file = await upload(people.uploader.headers, "quoted.png");
      const other = await upload(people.uploader.headers, "unquoted.png");
      const byId = `/api/projects/${projectId}/attachments/${file.id}/download/quoted.png`;
      const bySlug = `/api/projects/${slug}/attachments/${file.id}/view`;

      const linking = await json(
        await comment(people.otherReporter.headers, `see ![](${bySlug})`),
      );
      await comment(
        people.otherReporter.headers,
        // Same id, another project's address: not a link to this file.
        `[elsewhere](/api/projects/zzz/attachments/${file.id}/download/x)` +
          ` and [the other](/api/projects/${slug}/attachments/${other.id}/download/u)` +
          ` and a bare /attachments/${file.id}/ in prose`,
      );
      await t.app.request(`/api/projects/${slug}/issues/2`, {
        method: "PATCH",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ body: `the shot: [quoted.png](${byId})` }),
      });

      const res = await t.app.request(
        `/api/projects/${slug}/attachments/${file.id}/references`,
        { headers: people.uploader.headers },
      );
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual([
        { issue_number: 1, issue_ref: "#1", comment_id: linking.id },
        { issue_number: 2, issue_ref: "#2", comment_id: null },
      ]);
    });
  });

  describe("drafts (T-568)", () => {
    it("keeps an unsent draft off the list, the timeline and other readers", async () => {
      const before = (await eventsOf("attachment_added")).length;
      const draft = await upload(people.uploader.headers, "unsent.txt", {
        draft: true,
      });

      expect(await listed()).not.toContain(draft.id);
      expect((await eventsOf("attachment_added")).length).toBe(before);
      const own = await t.app.request(draft.url, {
        headers: people.uploader.headers,
      });
      expect(own.status).toBe(200);
      const other = await t.app.request(draft.url, {
        headers: people.writer.headers,
      });
      expect(other.status).toBe(404);
      const deleteOthers = await remove(people.writer.headers, draft.id);
      expect(deleteOthers.status).toBe(404);
    });

    it("attaches a draft when the uploader's comment links it", async () => {
      const draft = await upload(people.uploader.headers, "sent.png", {
        draft: true,
      });
      expect(await listed()).not.toContain(draft.id);
      const res = await comment(
        people.uploader.headers,
        `here ![sent.png](${draft.url})`,
      );
      expect(res.status).toBe(201);

      expect(await listed()).toContain(draft.id);
      const added = await eventsOf("attachment_added");
      expect(
        added.some(
          (e) =>
            (e.payload as { attachment: { id: number } }).attachment.id ===
            draft.id,
        ),
      ).toBe(true);
      const other = await t.app.request(draft.url, {
        headers: people.writer.headers,
      });
      expect(other.status).toBe(200);
    });

    it("attaches a draft when the uploader edits a body or comment to link it", async () => {
      // A reporter edits only their own card's body.
      const own = await json(
        await t.app.request(`/api/projects/${slug}/issues`, {
          method: "POST",
          headers: {
            ...people.uploader.headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "the uploader's own" }),
        }),
      );
      const forBody = await upload(people.uploader.headers, "body.png", {
        draft: true,
        issue: own.number,
      });
      const forEdit = await upload(people.uploader.headers, "edit.png", {
        draft: true,
      });
      const posted = await json(
        await comment(people.uploader.headers, "words first"),
      );

      await t.app.request(`/api/projects/${slug}/issues/${own.number}`, {
        method: "PATCH",
        headers: {
          ...people.uploader.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ body: `![](${forBody.url})` }),
      });
      await t.app.request(
        `/api/projects/${slug}/issues/1/comments/${posted.id}`,
        {
          method: "PATCH",
          headers: {
            ...people.uploader.headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ body: `words, then ![](${forEdit.url})` }),
        },
      );

      const draftFlags = await db
        .select({ id: attachments.id, draft: attachments.draft })
        .from(attachments);
      const flagOf = (id: number) => draftFlags.find((r) => r.id === id)?.draft;
      expect(flagOf(forBody.id)).toBe(false);
      expect(flagOf(forEdit.id)).toBe(false);
    });

    it("does not let someone else's text publish a draft", async () => {
      const draft = await upload(people.uploader.headers, "guessed.png", {
        draft: true,
      });
      await comment(people.writer.headers, `![](${draft.url})`);
      expect(await listed()).not.toContain(draft.id);
    });

    it("deletes a draft without a trace on the timeline", async () => {
      const before = (await eventsOf("attachment_deleted")).length;
      const draft = await upload(people.uploader.headers, "withdrawn.txt", {
        draft: true,
      });
      const res = await remove(people.uploader.headers, draft.id);
      expect(res.status).toBe(204);
      expect((await eventsOf("attachment_deleted")).length).toBe(before);
    });

    it("reaps drafts older than a day from the housekeeping tick, and nothing else", async () => {
      const stale = await upload(people.uploader.headers, "stale.txt", {
        draft: true,
      });
      const fresh = await upload(people.uploader.headers, "fresh.txt", {
        draft: true,
      });
      const old = await upload(people.uploader.headers, "old-but-sent.txt");
      const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
      for (const id of [stale.id, old.id]) {
        await db
          .update(attachments)
          .set({ createdAt: twoDaysAgo })
          .where(eq(attachments.id, id));
      }
      const staleKey = await storageKeyOf(stale.id);

      await runHousekeepingTick(t.ctx);

      const ids = (
        await db.select({ id: attachments.id }).from(attachments)
      ).map((r) => r.id);
      expect(ids).not.toContain(stale.id);
      expect(ids).toContain(fresh.id);
      expect(ids).toContain(old.id);
      expect(await t.ctx.storage.head(staleKey)).toBeNull();
    });

    it("dry-runs without deleting", async () => {
      const stale = await upload(people.uploader.headers, "dry.txt", {
        draft: true,
      });
      await db
        .update(attachments)
        .set({ createdAt: new Date(Date.now() - 48 * 3600 * 1000) })
        .where(eq(attachments.id, stale.id));
      const lines: string[] = [];
      const report = await reapDraftAttachments(t.ctx.router, t.ctx.storage, {
        dryRun: true,
        minAgeHours: 24,
        log: (line) => lines.push(line),
      });
      expect(report.wouldDelete).toBe(1);
      expect(lines.join("\n")).toContain(`draft attachment ${stale.id}`);
      expect(await storageKeyOf(stale.id)).toBeTruthy();
    });
  });

  // The reaper opens only marked projects, so the hourly tick costs the same
  // whatever the number of projects (the prefix-mirror tests pin that cost).
  describe("draft marks", () => {
    const system = () => t.ctx.router.system();
    const markOf = async () =>
      (
        await system()
          .select()
          .from(draftAttachmentMarks)
          .where(eq(draftAttachmentMarks.projectId, projectId))
      )[0];
    const ageMark = (hours: number) =>
      system()
        .update(draftAttachmentMarks)
        .set({ markedAt: new Date(Date.now() - hours * 3600 * 1000) })
        .where(eq(draftAttachmentMarks.projectId, projectId));
    const dropDrafts = () =>
      db.delete(attachments).where(eq(attachments.draft, true));

    it("marks the project when a draft lands, and not for a plain upload", async () => {
      await dropDrafts();
      await system().delete(draftAttachmentMarks);
      await upload(people.uploader.headers, "plain.txt");
      expect(await markOf()).toBeUndefined();
      await upload(people.uploader.headers, "marked.txt", { draft: true });
      expect(await markOf()).toBeDefined();
    });

    it("leaves a stale draft in an unmarked project alone", async () => {
      const stale = await upload(people.uploader.headers, "unwatched.txt", {
        draft: true,
      });
      await db
        .update(attachments)
        .set({ createdAt: new Date(Date.now() - 48 * 3600 * 1000) })
        .where(eq(attachments.id, stale.id));
      await system().delete(draftAttachmentMarks);

      await runHousekeepingTick(t.ctx);

      expect(await storageKeyOf(stale.id)).toBeTruthy();
    });

    it("keeps a mark that is fresh or still has drafts, and drops it after", async () => {
      await dropDrafts();
      await system().delete(draftAttachmentMarks);
      const draft = await upload(people.uploader.headers, "pending.txt", {
        draft: true,
      });

      await runHousekeepingTick(t.ctx);
      expect(await markOf()).toBeDefined();

      // Old, but a draft is still there.
      await ageMark(2);
      await runHousekeepingTick(t.ctx);
      expect(await markOf()).toBeDefined();

      // No draft left, but refreshed within the hour: an upload may be
      // between marking and writing its row.
      await remove(people.uploader.headers, draft.id);
      await ageMark(0);
      await runHousekeepingTick(t.ctx);
      expect(await markOf()).toBeDefined();

      await ageMark(2);
      await runHousekeepingTick(t.ctx);
      expect(await markOf()).toBeUndefined();
    });
  });
});
