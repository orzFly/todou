import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/driver.ts";
import * as projectSchema from "../src/db/project-schema.ts";
import {
  attachments,
  insightsSettings,
  issueAssignees,
  issueLabels,
  issueMentions,
  issues,
  pendingUploads,
  readFrontiers,
  revisions,
} from "../src/db/project-schema.ts";
import { blobReaps, projects } from "../src/db/system-schema.ts";
import { runHousekeepingTick } from "../src/services/housekeeping.ts";
import { PROJECT_OWNED_TABLES } from "../src/services/projects.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Every project-schema table that carries a `project_id` column, asked of the schema. */
const PROJECT_ID_TABLES: string[] = [];
for (const exported of Object.values(projectSchema)) {
  if (!is(exported, PgTable)) continue;
  const config = getTableConfig(exported);
  if (config.columns.some((c) => c.name === "project_id")) {
    PROJECT_ID_TABLES.push(config.name);
  }
}
PROJECT_ID_TABLES.sort();

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

type Project = { id: number; slug: string; db: Db };

/** The API surface the tests below share; one per app. */
function client(t: TestApp, cookie: string) {
  const api = (path: string, init?: RequestInit) =>
    t.app.request(`/api${path}`, {
      ...init,
      headers:
        typeof init?.body === "string"
          ? { "content-type": "application/json", cookie }
          : { cookie },
    });

  async function createProject(slug: string): Promise<Project> {
    const res = await api("/projects", {
      method: "POST",
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
    const { id } = await json(res);
    const row = (
      await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.id, id))
    )[0];
    if (!row) throw new Error("project row missing");
    // Opened now so it can still be read after the registry row is gone.
    const db = await t.ctx.router.forProject({
      id,
      slug,
      database_url: row.databaseUrl,
    });
    return { id, slug, db };
  }

  async function createIssue(slug: string, title: string, body = "") {
    const res = await api(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number; number: number };
  }

  async function upload(slug: string, number: number, content: string) {
    const form = new FormData();
    form.set("file", new File([content], "f.txt", { type: "text/plain" }));
    form.set("issue_number", String(number));
    const res = await api(`/projects/${slug}/attachments`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { id: number };
  }

  async function uploadIcon(slug: string) {
    const form = new FormData();
    form.set("file", new File([PNG_BYTES], "icon.png", { type: "image/png" }));
    const res = await api(`/projects/${slug}/icon`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(200);
    const row = (
      await t.ctx.router
        .system()
        .select({ key: projects.iconKey })
        .from(projects)
        .where(eq(projects.slug, slug))
    )[0];
    return row?.key as string;
  }

  async function keyOf(project: Project, attachmentId: number) {
    const row = (
      await project.db
        .select({ key: attachments.storageKey })
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
    )[0];
    if (!row) throw new Error("attachment row missing");
    return row.key;
  }

  async function download(slug: string, attachmentId: number) {
    const res = await api(
      `/projects/${slug}/attachments/${attachmentId}/download`,
    );
    if (res.status === 302) {
      // s3: the route redirects to a presigned URL.
      const direct = await fetch(res.headers.get("location") as string);
      return { status: direct.status, text: await direct.text() };
    }
    return {
      status: res.status,
      text: res.status === 200 ? await res.text() : "",
    };
  }

  async function move(from: string, number: number, to: string) {
    const res = await api(`/projects/${from}/issues/${number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: to }),
    });
    expect(res.status).toBe(200);
    return (await json(res)).moved_to.number as number;
  }

  /** The attachments a card carries, read from its project's database. */
  async function attachmentsOf(project: Project, number: number) {
    const [issue] = await project.db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.projectId, project.id), eq(issues.number, number)));
    return project.db
      .select()
      .from(attachments)
      .where(eq(attachments.issueId, issue?.id ?? -1));
  }

  async function deleteProject(slug: string) {
    return (await api(`/projects/${slug}`, { method: "DELETE" })).status;
  }

  return {
    api,
    createProject,
    createIssue,
    upload,
    uploadIcon,
    keyOf,
    download,
    move,
    attachmentsOf,
    deleteProject,
  };
}

type Client = ReturnType<typeof client>;

const countIn = async (db: Db, table: string, projectId: number) => {
  const got = await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where project_id = ${projectId}`,
  );
  // biome-ignore lint/suspicious/noExplicitAny: driver-agnostic result shape
  const rows = (got as any).rows ?? got;
  return Number(rows[0]?.n ?? 0);
};

const countsOf = async (project: Project) => {
  const counts: Record<string, number> = {};
  for (const table of PROJECT_ID_TABLES) {
    counts[table] = await countIn(project.db, table, project.id);
  }
  return counts;
};

/** One row or more in every project_id table, by the API where it reaches. */
async function populate(c: Client, P: Project) {
  const { api } = c;
  const issue = await c.createIssue(P.slug, "everything", "SECRET=hunter2");
  const path = `/projects/${P.slug}/issues/${issue.number}`;
  const ok = async (res: Response | Promise<Response>) => {
    expect((await res).status).toBeLessThan(300);
  };
  await c.upload(P.slug, issue.number, `${P.slug} everything bytes`);
  await ok(
    api(path, { method: "PATCH", body: JSON.stringify({ body: "edited" }) }),
  );
  const comment = await json(
    await api(`${path}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "first words" }),
    }),
  );
  await ok(
    api(`${path}/comments/${comment.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "second words" }),
    }),
  );
  await ok(
    api(`/projects/${P.slug}/references/autolinks`, {
      method: "POST",
      body: JSON.stringify({
        prefix: "JIRA-",
        url_template: "https://example.com/<num>",
      }),
    }),
  );
  await ok(
    api(`/projects/${P.slug}/references/format`, {
      method: "PUT",
      body: JSON.stringify({ prefix: "E" }),
    }),
  );
  const label = await json(
    await api(`/projects/${P.slug}/labels`, {
      method: "POST",
      body: JSON.stringify({ name: "doomed" }),
    }),
  );
  const author = (
    await P.db
      .select({ id: issues.authorId })
      .from(issues)
      .where(eq(issues.id, issue.id))
  )[0]?.id as number;
  await ok(
    api(path, {
      method: "PATCH",
      body: JSON.stringify({ label_ids: [label.id], assignee_ids: [author] }),
    }),
  );
  await ok(
    api(`${path}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({
        entries: [{ namespace: "orch", key: "k", value: "v" }],
      }),
    }),
  );
  await ok(
    api(`${path}/mute`, {
      method: "PUT",
      body: JSON.stringify({ mode: "forever" }),
    }),
  );
  await ok(api(`${path}/read`, { method: "PUT", body: JSON.stringify({}) }));
  await ok(
    api(`${path}/spec/push`, {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "plan.md", body: "# plan" }] }),
    }),
  );
  // What the API does not reach on this backend, or not without a second
  // account: written directly.
  await P.db
    .insert(insightsSettings)
    .values({ projectId: P.id, roles: { x: "y" } })
    .onConflictDoNothing();
  await P.db
    .insert(readFrontiers)
    .values({ projectId: P.id, userId: author, frontierAt: new Date() })
    .onConflictDoNothing();
  await P.db.insert(issueMentions).values({
    projectId: P.id,
    issueId: issue.id,
    userId: author,
    actorId: author,
  });
  await P.db.insert(pendingUploads).values({
    projectId: P.id,
    issueId: issue.id,
    uploaderId: author,
    filename: "p.txt",
    contentType: "text/plain",
    declaredSize: 1,
    storageKey: `aa/bb/${P.slug}`,
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  return issue;
}

describe("PROJECT_OWNED_TABLES", () => {
  it("names every table the schema gives a project_id column", () => {
    // The list is a list; this asks the schema. A table added later and
    // forgotten there keeps a deleted project's rows forever.
    const listed = PROJECT_OWNED_TABLES.map((t) => getTableConfig(t).name);
    expect([...listed].sort()).toEqual(PROJECT_ID_TABLES);
    expect(listed[0]).toBe("issues");
  });
});

describe.each(PLACEMENTS)(
  "deleting a project erases it (%s placement)",
  (placement) => {
    let t: TestApp;
    let c: Client;

    beforeAll(async () => {
      t = await makeTestApp(placement);
      c = client(t, await t.login());
    });

    afterAll(async () => {
      await t.cleanup();
    });

    it("leaves neither its attachment blobs nor superseded text behind", async () => {
      const P = await c.createProject(`erase-p-${placement}`);
      const Q = await c.createProject(`erase-q-${placement}`);
      const issue = await c.createIssue(
        P.slug,
        "holds a secret",
        "SECRET=hunter2",
      );
      const pFile = await c.upload(P.slug, issue.number, "p bytes");
      const pKey = await c.keyOf(P, pFile.id);
      const edited = await c.api(`/projects/${P.slug}/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "nothing to see" }),
      });
      expect(edited.status).toBe(200);
      const qIssue = await c.createIssue(Q.slug, "bystander");
      const qFile = await c.upload(Q.slug, qIssue.number, "q bytes");
      const qKey = await c.keyOf(Q, qFile.id);
      expect(await countIn(P.db, "revisions", P.id)).toBeGreaterThan(0);

      expect(await c.deleteProject(P.slug)).toBe(204);

      expect(await t.ctx.storage.head(pKey)).toBe(null);
      expect(await countIn(P.db, "revisions", P.id)).toBe(0);
      const leaked = await P.db
        .select({ id: revisions.id })
        .from(revisions)
        .where(sql`${revisions.body} like '%SECRET=hunter2%'`);
      expect(leaked).toEqual([]);
      expect(await t.ctx.storage.head(qKey)).not.toBe(null);
      expect(await c.download(Q.slug, qFile.id)).toEqual({
        status: 200,
        text: "q bytes",
      });
    });

    // Guards against a delete that forgot its `where project_id`.
    it("leaves every row of a project beside it as it was", async () => {
      const P = await c.createProject(`erase-near-p-${placement}`);
      const Q = await c.createProject(`erase-near-q-${placement}`);
      await populate(c, P);
      await populate(c, Q);
      const qKeys = (await Q.db.select().from(attachments)).filter(
        (a) => a.projectId === Q.id,
      );
      const before = await countsOf(Q);

      expect(await c.deleteProject(P.slug)).toBe(204);

      expect(await countsOf(Q)).toEqual(before);
      for (const a of qKeys) {
        expect(await t.ctx.storage.head(a.storageKey)).not.toBe(null);
      }
    });

    // Guards against collecting `attachment_key`, or a registration check
    // that no longer looks in the target project's database.
    it("keeps the attachments of a card moved out before the deletion", async () => {
      const P = await c.createProject(`erase-moved-p-${placement}`);
      const Q = await c.createProject(`erase-moved-q-${placement}`);
      const issue = await c.createIssue(P.slug, "leaves first");
      await c.upload(P.slug, issue.number, "carried bytes");
      const landed = await c.move(P.slug, issue.number, Q.slug);

      expect(await c.deleteProject(P.slug)).toBe(204);
      await runHousekeepingTick(t.ctx);

      const [carried] = await c.attachmentsOf(Q, landed);
      expect(await c.download(Q.slug, carried?.id ?? -1)).toEqual({
        status: 200,
        text: "carried bytes",
      });
    });

    // Guards against the icon going nowhere once the direct delete is gone.
    it("deletes the icon, and the hourly tick retries it after a failure", async () => {
      const P = await c.createProject(`erase-icon-p-${placement}`);
      const Q = await c.createProject(`erase-icon-q-${placement}`);
      const pIcon = await c.uploadIcon(P.slug);
      const qIcon = await c.uploadIcon(Q.slug);

      expect(await c.deleteProject(P.slug)).toBe(204);
      expect(await t.ctx.storage.head(pIcon)).toBe(null);
      expect(await t.ctx.storage.head(qIcon)).not.toBe(null);
      expect((await c.api(`/projects/${Q.slug}/icon`)).status).toBe(200);

      const R = await c.createProject(`erase-icon-r-${placement}`);
      const rIcon = await c.uploadIcon(R.slug);
      const spy = vi
        .spyOn(t.ctx.storage, "delete")
        .mockRejectedValueOnce(new Error("storage said no"));
      try {
        expect(await c.deleteProject(R.slug)).toBe(204);
      } finally {
        spy.mockRestore();
      }
      expect(await t.ctx.storage.head(rIcon)).not.toBe(null);
      const listed = () =>
        t.ctx.router
          .system()
          .select()
          .from(blobReaps)
          .where(eq(blobReaps.key, rIcon));
      expect(await listed()).toHaveLength(1);

      await runHousekeepingTick(t.ctx);

      expect(await t.ctx.storage.head(rIcon)).toBe(null);
      expect(await listed()).toEqual([]);
    });

    it("refuses the deletion while the project's database cannot be read", async () => {
      const [row] = await t.ctx.router
        .system()
        .insert(projects)
        .values({
          slug: `erase-unreadable-${placement}`,
          name: "unreadable",
          databaseUrl: "postgres://127.0.0.1:1/nope",
        })
        .returning();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await c.deleteProject(`erase-unreadable-${placement}`)).toBe(
          500,
        );
      } finally {
        spy.mockRestore();
      }
      const still = await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.id, row?.id ?? -1));
      expect(still).toHaveLength(1);
      await t.ctx.router
        .system()
        .delete(projects)
        .where(eq(projects.id, row?.id ?? -1));
    });
  },
);

describe("deleting a project empties every table that carries its id", () => {
  let t: TestApp;
  let c: Client;

  beforeAll(async () => {
    t = await makeTestApp("shared");
    c = client(t, await t.login());
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("removes every row of the deleted project, table by table", async () => {
    const P = await c.createProject("erase-every-table");
    const issue = await populate(c, P);

    // The other half of "every count is 0" below: a table nothing wrote to
    // would pass that half without proving anything.
    const empty: string[] = [];
    for (const table of PROJECT_ID_TABLES) {
      if ((await countIn(P.db, table, P.id)) === 0) empty.push(table);
    }
    expect(empty).toEqual([]);
    const linked = async () =>
      (
        await P.db
          .select()
          .from(issueAssignees)
          .where(eq(issueAssignees.issueId, issue.id))
      ).length +
      (
        await P.db
          .select()
          .from(issueLabels)
          .where(eq(issueLabels.issueId, issue.id))
      ).length;
    expect(await linked()).toBe(2);

    expect(await c.deleteProject(P.slug)).toBe(204);

    const left: Record<string, number> = {};
    for (const table of PROJECT_ID_TABLES) {
      const n = await countIn(P.db, table, P.id);
      if (n > 0) left[table] = n;
    }
    expect(left).toEqual({});
    expect(await linked()).toBe(0);
  });
});

// Guards against collecting the keys after the `rm` that takes the only
// place they were written.
describe("deleting a project that owns its PGlite directory", () => {
  let t: TestApp;
  let c: Client;
  let root: string;

  beforeAll(async () => {
    root = testTmpDir("todou-erase-pglite-");
    t = await makeTestApp("dedicated", {
      urlTemplate: `pglite://${root}/p-\${project.id}`,
    });
    c = client(t, await t.login());
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("removes the directory, the attachments and the icon, and nothing of the next project", async () => {
    const P = await c.createProject("erase-file-p");
    const Q = await c.createProject("erase-file-q");
    const issue = await c.createIssue(P.slug, "on its own file");
    const pKey = await c.keyOf(
      P,
      (await c.upload(P.slug, issue.number, "p file bytes")).id,
    );
    const pIcon = await c.uploadIcon(P.slug);
    const qIssue = await c.createIssue(Q.slug, "next door");
    const qFile = await c.upload(Q.slug, qIssue.number, "q file bytes");
    expect(existsSync(join(root, `p-${P.id}`))).toBe(true);

    expect(await c.deleteProject(P.slug)).toBe(204);

    expect(existsSync(join(root, `p-${P.id}`))).toBe(false);
    expect(await t.ctx.storage.head(pKey)).toBe(null);
    expect(await t.ctx.storage.head(pIcon)).toBe(null);
    expect(await c.download(Q.slug, qFile.id)).toEqual({
      status: 200,
      text: "q file bytes",
    });
  });
});

// Guards against a key that a move half-done left on both sides: the
// target's row is what says the object is not ours to delete.
describe("deleting a project mid-move", () => {
  let t: TestApp;
  let c: Client;

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
    c = client(t, await t.login());
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("keeps an object the target project's copy already names", async () => {
    const P = await c.createProject("erase-midmove-p");
    const Q = await c.createProject("erase-midmove-q");
    const issue = await c.createIssue(P.slug, "half moved");
    const pFile = await c.upload(P.slug, issue.number, "half moved bytes");
    const [source] = await P.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, pFile.id));
    const qIssue = await c.createIssue(Q.slug, "the copy");
    if (!source) throw new Error("attachment missing");
    const [copy] = await Q.db
      .insert(attachments)
      .values({
        projectId: Q.id,
        issueId: qIssue.id,
        uploaderId: source.uploaderId,
        filename: source.filename,
        contentType: source.contentType,
        size: source.size,
        storageKey: source.storageKey,
      })
      .returning();

    expect(await c.deleteProject(P.slug)).toBe(204);
    await runHousekeepingTick(t.ctx);

    expect(await t.ctx.storage.head(source.storageKey)).not.toBe(null);
    expect(await c.download(Q.slug, copy?.id ?? -1)).toEqual({
      status: 200,
      text: "half moved bytes",
    });
  });
});

describe.each(PLACEMENTS)(
  "deleting a project with direct-upload tickets out (%s placement)",
  (placement) => {
    let t: TestApp;
    let c: Client;
    let fake: FakeS3;

    beforeAll(async () => {
      fake = await startFakeS3();
      t = await makeTestApp(placement, { s3: { endpoint: fake.url } });
      c = client(t, await t.login());
    });

    afterAll(async () => {
      await t.cleanup();
      await fake.close();
    });

    async function ticketFor(slug: string, number: number, body: string) {
      const res = await c.api(`/projects/${slug}/attachments/direct-uploads`, {
        method: "POST",
        body: JSON.stringify({
          issue_number: number,
          filename: "f.txt",
          content_type: "text/plain",
          size: body.length,
        }),
      });
      expect(res.status).toBe(201);
      return (await json(res)) as { upload_id: number; url: string };
    }

    const put = async (url: string, body: string) => {
      const res = await fetch(url, { method: "PUT", body });
      expect(res.ok).toBe(true);
    };

    const complete = async (slug: string, uploadId: number) => {
      const res = await c.api(
        `/projects/${slug}/attachments/direct-uploads/${uploadId}/complete`,
        { method: "POST" },
      );
      expect(res.status).toBe(201);
      return (await json(res)) as { id: number };
    };

    const holding = (body: string) =>
      [...fake.objects.values()].filter((b) => b.toString() === body);

    const pastDue = () =>
      t.ctx.router
        .system()
        .update(blobReaps)
        .set({ deleteAfter: new Date(Date.now() - 3600 * 1000) });

    // Guards against an upload row dropped on the first delete, which
    // leaves a replay's bytes unlisted for good.
    it("deletes what a ticket replays after the deletion, once the ticket has run out", async () => {
      const P = await c.createProject(`erase-replay-p-${placement}`);
      const issue = await c.createIssue(P.slug, "ticket out");
      const ticket = await ticketFor(P.slug, issue.number, "replayed bytes");
      await put(ticket.url, "replayed bytes");

      expect(await c.deleteProject(P.slug)).toBe(204);
      expect(holding("replayed bytes")).toHaveLength(0);

      await put(ticket.url, "replayed bytes");
      expect(holding("replayed bytes")).toHaveLength(1);
      const listed = () =>
        t.ctx.router
          .system()
          .select()
          .from(blobReaps)
          .where(eq(blobReaps.projectId, P.id));
      await runHousekeepingTick(t.ctx);
      expect(holding("replayed bytes")).toHaveLength(1);
      expect(await listed()).toHaveLength(1);

      await pastDue();
      await runHousekeepingTick(t.ctx);
      expect(holding("replayed bytes")).toHaveLength(0);
      expect(await listed()).toEqual([]);
    });

    it("deletes both the upload key and the attachment of a completed ticket", async () => {
      const P = await c.createProject(`erase-done-p-${placement}`);
      const issue = await c.createIssue(P.slug, "ticket done");
      const ticket = await ticketFor(P.slug, issue.number, "completed bytes");
      await put(ticket.url, "completed bytes");
      await complete(P.slug, ticket.upload_id);
      // Since T-653 the upload key holds only what a replay writes there.
      await put(ticket.url, "completed bytes");
      expect(holding("completed bytes")).toHaveLength(2);

      expect(await c.deleteProject(P.slug)).toBe(204);

      expect(holding("completed bytes")).toHaveLength(0);
    });

    // Before T-653 the attachment took the upload key itself, and the row
    // stays on the tombstone when the card moves: the key it names is then
    // the target project's attachment.
    it("keeps the attachment of a ticket completed before T-653 whose card moved out", async () => {
      const P = await c.createProject(`erase-old-p-${placement}`);
      const Q = await c.createProject(`erase-old-q-${placement}`);
      const issue = await c.createIssue(P.slug, "old ticket");
      const ticket = await ticketFor(P.slug, issue.number, "old bytes");
      await put(ticket.url, "old bytes");
      await complete(P.slug, ticket.upload_id);
      const [row] = await P.db
        .select()
        .from(pendingUploads)
        .where(eq(pendingUploads.id, ticket.upload_id));
      if (!row?.attachmentKey) throw new Error("upload row missing");
      fake.objects.set(
        row.storageKey,
        fake.objects.get(row.attachmentKey) as Buffer,
      );
      fake.objects.delete(row.attachmentKey);
      await P.db
        .update(attachments)
        .set({ storageKey: row.storageKey })
        .where(eq(attachments.storageKey, row.attachmentKey));
      await P.db
        .update(pendingUploads)
        .set({ attachmentKey: null })
        .where(eq(pendingUploads.id, row.id));
      const landed = await c.move(P.slug, issue.number, Q.slug);

      expect(await c.deleteProject(P.slug)).toBe(204);
      await pastDue();
      await runHousekeepingTick(t.ctx);

      const [carried] = await c.attachmentsOf(Q, landed);
      expect(carried?.storageKey).toBe(row.storageKey);
      expect(await c.download(Q.slug, carried?.id ?? -1)).toEqual({
        status: 200,
        text: "old bytes",
      });
    });
  },
);
