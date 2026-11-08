import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import { attachments } from "../src/db/project-schema.ts";
import { blobReaps, projects } from "../src/db/system-schema.ts";
import {
  type BlobReapEntry,
  enlistBlobs,
  reapBlobs,
} from "../src/services/storage-admin.ts";
import type { StorageBackend } from "../src/storage/types.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import {
  countStatements,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const quiet = () => {};
const HOUR = 3600 * 1000;
/** No project ever gets this id; stands in for one deleted long ago. */
const GONE = 987_654;

const newKey = () => {
  const uuid = randomUUID();
  return `${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
};

const entry = (
  key: string,
  kind: BlobReapEntry["kind"],
  deleteAfter = new Date(Date.now() - HOUR),
  projectId = GONE,
): BlobReapEntry => ({ key, kind, projectId, deleteAfter });

async function listed(t: TestApp): Promise<string[]> {
  return (
    await t.ctx.router.system().select({ key: blobReaps.key }).from(blobReaps)
  )
    .map((r) => r.key)
    .sort();
}

/** A project with one card and one attachment on it, through the API. */
async function projectWithAttachment(
  t: TestApp,
  cookie: string,
  slug: string,
): Promise<{ id: number; db: Db; key: string; attachmentId: number }> {
  const headers = { "content-type": "application/json", cookie };
  const created = await t.app.request("/api/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({ slug, name: slug }),
  });
  expect(created.status).toBe(201);
  const { id } = await json(created);
  await t.app.request(`/api/projects/${slug}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "holds a file" }),
  });
  const form = new FormData();
  form.set(
    "file",
    new File([`${slug} bytes`], "f.txt", { type: "text/plain" }),
  );
  form.set("issue_number", "1");
  const uploaded = await t.app.request(`/api/projects/${slug}/attachments`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  expect(uploaded.status).toBe(201);
  const attachmentId = (await json(uploaded)).id as number;
  const row = (
    await t.ctx.router
      .system()
      .select()
      .from(projects)
      .where(eq(projects.id, id))
  )[0];
  const db = await t.ctx.router.forProject({
    id,
    slug,
    database_url: row?.databaseUrl ?? null,
  });
  const key = (
    await db
      .select({ key: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
  )[0]?.key as string;
  return { id, db, key, attachmentId };
}

describe("reapBlobs on fs", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  beforeEach(async () => {
    await t.ctx.router.system().delete(blobReaps);
  });

  const put = async (key: string) => {
    await t.ctx.storage.put(key, new TextEncoder().encode("x"));
    return key;
  };

  it("costs one system query and opens no project database when nothing is listed", async () => {
    await projectWithAttachment(t, cookie, "reap-n-free");
    const log = await countStatements(t, () =>
      reapBlobs(t.ctx.router, t.ctx.storage, { dryRun: false, log: quiet }),
    );
    expect(log.total).toBe(1);
    expect(Object.keys(log.byUrl)).toEqual([t.ctx.router.systemHandle().url]);
  });

  it("drops the row of a key a deleted project's own leftover row names, and deletes it", async () => {
    // Shared placement: a project whose row cleanup failed leaves its
    // attachment rows beside every live project's.
    const leftover = await projectWithAttachment(t, cookie, "reap-leftover");
    await t.ctx.router
      .system()
      .delete(projects)
      .where(eq(projects.id, leftover.id));
    await enlistBlobs(t.ctx.router.system(), [
      entry(leftover.key, "attachment", undefined, leftover.id),
    ]);

    const report = await reapBlobs(t.ctx.router, t.ctx.storage, {
      dryRun: false,
      log: quiet,
    });

    expect(report.deletedObjects).toBe(1);
    expect(await t.ctx.storage.head(leftover.key)).toBe(null);
    expect(await listed(t)).toEqual([]);
  });

  it("deletes nothing while a live project's database cannot be read", async () => {
    const key = await put(newKey());
    await enlistBlobs(t.ctx.router.system(), [entry(key, "attachment")]);
    const [broken] = await t.ctx.router
      .system()
      .insert(projects)
      .values({
        slug: "reap-unreadable",
        name: "unreadable",
        databaseUrl: "postgres://127.0.0.1:1/nope",
      })
      .returning();

    const blocked = await reapBlobs(t.ctx.router, t.ctx.storage, {
      dryRun: false,
      log: quiet,
    });
    expect(blocked.failed).toBe(1);
    expect(blocked.deletedObjects).toBe(0);
    expect(await t.ctx.storage.head(key)).not.toBe(null);
    expect(await listed(t)).toEqual([key]);

    await t.ctx.router
      .system()
      .delete(projects)
      .where(eq(projects.id, broken?.id ?? -1));
    const report = await reapBlobs(t.ctx.router, t.ctx.storage, {
      dryRun: false,
      log: quiet,
    });
    expect(report.deletedObjects).toBe(1);
    expect(await t.ctx.storage.head(key)).toBe(null);
    expect(await listed(t)).toEqual([]);
  });

  it("keeps the row of an object whose delete failed, for the next pass", async () => {
    const bad = await put(newKey());
    const good = await put(newKey());
    await enlistBlobs(t.ctx.router.system(), [
      entry(bad, "attachment"),
      entry(good, "icon"),
    ]);
    const inner = t.ctx.storage;
    const flaky: StorageBackend = {
      put: (k, d) => inner.put(k, d),
      getStream: (k) => inner.getStream(k),
      head: (k) => inner.head(k),
      urlFor: (k, o) => inner.urlFor(k, o),
      list: (o) => inner.list(o),
      delete: async (k) => {
        if (k === bad) throw new Error("storage said no");
        await inner.delete(k);
      },
    };

    const first = await reapBlobs(t.ctx.router, flaky, {
      dryRun: false,
      log: quiet,
    });
    expect(first.failed).toBe(1);
    expect(await t.ctx.storage.head(good)).toBe(null);
    expect(await t.ctx.storage.head(bad)).not.toBe(null);
    expect(await listed(t)).toEqual([bad]);

    await reapBlobs(t.ctx.router, inner, { dryRun: false, log: quiet });
    expect(await t.ctx.storage.head(bad)).toBe(null);
    expect(await listed(t)).toEqual([]);
  });

  it("leaves upload keys alone off s3, and deletes the attachment beside them", async () => {
    const upload = await put(newKey());
    const attachment = await put(newKey());
    await enlistBlobs(t.ctx.router.system(), [
      entry(upload, "upload"),
      entry(attachment, "attachment"),
    ]);

    const report = await reapBlobs(t.ctx.router, t.ctx.storage, {
      dryRun: false,
      log: quiet,
    });

    expect(report.kept).toBe(1);
    expect(await t.ctx.storage.head(upload)).not.toBe(null);
    expect(await t.ctx.storage.head(attachment)).toBe(null);
    expect(await listed(t)).toEqual([upload]);
  });

  it("counts each row once when two passes overlap", async () => {
    const keys = [
      await put(newKey()),
      await put(newKey()),
      await put(newKey()),
    ];
    await enlistBlobs(
      t.ctx.router.system(),
      keys.map((k) => entry(k, "attachment")),
    );
    const opts = { dryRun: false, log: quiet };
    const [a, b] = await Promise.all([
      reapBlobs(t.ctx.router, t.ctx.storage, opts),
      reapBlobs(t.ctx.router, t.ctx.storage, opts),
    ]);
    expect(a.droppedRows + b.droppedRows).toBe(3);
    expect(a.failed + b.failed).toBe(0);
    for (const k of keys) expect(await t.ctx.storage.head(k)).toBe(null);
  });

  it("only reports on a dry run", async () => {
    const key = await put(newKey());
    await enlistBlobs(t.ctx.router.system(), [entry(key, "attachment")]);

    const report = await reapBlobs(t.ctx.router, t.ctx.storage, {
      dryRun: true,
      log: quiet,
    });

    expect(report.wouldDelete).toBe(1);
    expect(report.deletedObjects).toBe(0);
    expect(await t.ctx.storage.head(key)).not.toBe(null);
    expect(await listed(t)).toEqual([key]);
  });

  it("folds a key listed twice into one row with the later deadline", async () => {
    const key = newKey();
    const later = new Date(Date.now() + 5 * HOUR);
    await enlistBlobs(t.ctx.router.system(), [
      entry(key, "attachment"),
      entry(key, "upload", later),
    ]);
    await enlistBlobs(t.ctx.router.system(), [entry(key, "upload")]);
    const rows = await t.ctx.router.system().select().from(blobReaps);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("attachment");
    expect(rows[0]?.deleteAfter.getTime()).toBe(later.getTime());
  });
});

describe.each(PLACEMENTS)(
  "reapBlobs and live attachments (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
    });

    afterAll(async () => {
      await t.cleanup();
    });

    it("drops the row of a key a live project's attachment names, and keeps the object", async () => {
      const q = await projectWithAttachment(
        t,
        cookie,
        `reap-live-${placement}`,
      );
      await enlistBlobs(t.ctx.router.system(), [
        entry(q.key, "attachment"),
        entry(newKey(), "upload"),
      ]);

      await reapBlobs(t.ctx.router, t.ctx.storage, {
        dryRun: false,
        log: quiet,
      });

      expect(await t.ctx.storage.head(q.key)).not.toBe(null);
      const left = await t.ctx.router
        .system()
        .select()
        .from(blobReaps)
        .where(eq(blobReaps.key, q.key));
      expect(left).toEqual([]);
    });
  },
);

describe("reapBlobs on s3", () => {
  let t: TestApp;
  let fake: FakeS3;

  beforeAll(async () => {
    fake = await startFakeS3();
    t = await makeTestApp("shared", { s3: { endpoint: fake.url } });
  });

  afterAll(async () => {
    await t.cleanup();
    await fake.close();
  });

  it("deletes an upload key only once its deadline has passed", async () => {
    const key = newKey();
    await t.ctx.storage.put(key, new TextEncoder().encode("replayed"));
    await enlistBlobs(t.ctx.router.system(), [
      entry(key, "upload", new Date(Date.now() + HOUR)),
    ]);

    await reapBlobs(t.ctx.router, t.ctx.storage, { dryRun: false, log: quiet });
    expect(fake.objects.has(key)).toBe(true);
    expect(await listed(t)).toEqual([key]);

    await t.ctx.router
      .system()
      .update(blobReaps)
      .set({ deleteAfter: new Date(Date.now() - HOUR) })
      .where(eq(blobReaps.key, key));
    await reapBlobs(t.ctx.router, t.ctx.storage, { dryRun: false, log: quiet });
    expect(fake.objects.has(key)).toBe(false);
    expect(await listed(t)).toEqual([]);
  });
});
