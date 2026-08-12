import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.ts";
import { pendingUploads } from "../src/db/project-schema.ts";
import { projects } from "../src/db/system-schema.ts";
import {
  copyMissing,
  enumerateBlobKeys,
  gcPendingUploads,
} from "../src/services/storage-admin.ts";
import { FsStorage } from "../src/storage/fs.ts";
import { S3Storage } from "../src/storage/s3.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const quiet = () => {};

function s3StorageFor(fake: FakeS3): S3Storage {
  const config: Config = loadConfig({
    tomlSource: [
      "[storage]",
      'backend = "s3"',
      "[storage.s3]",
      `endpoint = '${fake.url}'`,
      `bucket = '${fake.bucket}'`,
      "access_key_id = 'test-ak'",
      "secret_access_key = 'test-sk'",
      "retries = 1",
      "request_timeout_ms = 2000",
    ].join("\n"),
    env: {},
  });
  if (!config.s3Credentials) throw new Error("credentials not resolved");
  return new S3Storage(config.storage.s3, config.s3Credentials);
}

describe("storage migrate primitives", () => {
  let t: TestApp;
  let cookie: string;
  let fake: FakeS3;
  let fsStorage: FsStorage;
  let s3Storage: S3Storage;
  const slug = "migrate-src";

  beforeAll(async () => {
    fake = await startFakeS3();
    s3Storage = s3StorageFor(fake);
    t = await makeTestApp("shared");
    fsStorage = new FsStorage(t.ctx.config.storage.path);
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "Migrate Src" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "carries files" }),
    });
    for (const [name, content] of [
      ["one.txt", "first blob"],
      ["two.txt", "second blob, longer"],
    ] as const) {
      const form = new FormData();
      form.set("file", new File([content], name, { type: "text/plain" }));
      form.set("issue_number", "1");
      const res = await t.app.request(`/api/projects/${slug}/attachments`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      expect(res.status).toBe(201);
    }
    const avatar = new FormData();
    avatar.set(
      "file",
      new File(["png-ish bytes"], "a.png", { type: "image/png" }),
    );
    const res = await t.app.request("/api/me/avatar", {
      method: "POST",
      headers: { cookie },
      body: avatar,
    });
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await t.cleanup();
    await fake.close();
  });

  it("enumerates attachments and avatars from the databases", async () => {
    const keys = await enumerateBlobKeys(t.ctx.router);
    expect(keys.length).toBe(3);
    expect(keys.filter((k) => k.origin.startsWith("avatar:")).length).toBe(1);
    expect(keys.filter((k) => k.origin.startsWith(`${slug}#att`)).length).toBe(
      2,
    );
  });

  it("dry-run counts copies without writing", async () => {
    const keys = await enumerateBlobKeys(t.ctx.router);
    const report = await copyMissing(fsStorage, s3Storage, keys, {
      dryRun: true,
      log: quiet,
    });
    expect(report).toEqual({ copied: 3, skipped: 0, failed: 0 });
    expect(fake.objects.size).toBe(0);
  });

  it("copies fs → s3, then skips everything on the re-run", async () => {
    const keys = await enumerateBlobKeys(t.ctx.router);
    const first = await copyMissing(fsStorage, s3Storage, keys, {
      dryRun: false,
      log: quiet,
    });
    expect(first).toEqual({ copied: 3, skipped: 0, failed: 0 });
    for (const { key } of keys) {
      const fsHead = await fsStorage.head(key);
      expect(await s3Storage.head(key)).toEqual(fsHead);
    }
    const second = await copyMissing(fsStorage, s3Storage, keys, {
      dryRun: false,
      log: quiet,
    });
    expect(second).toEqual({ copied: 0, skipped: 3, failed: 0 });
  });

  it("copies s3 → fs into a fresh root byte-for-byte", async () => {
    const keys = await enumerateBlobKeys(t.ctx.router);
    const freshRoot = mkdtempSync(join(tmpdir(), "todou-migrate-back-"));
    const fsBack = new FsStorage(freshRoot);
    const report = await copyMissing(s3Storage, fsBack, keys, {
      dryRun: false,
      log: quiet,
    });
    expect(report).toEqual({ copied: 3, skipped: 0, failed: 0 });
    for (const { key } of keys) {
      const { stream } = await fsBack.getStream(key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      expect(fake.objects.get(key)?.equals(Buffer.concat(chunks))).toBe(true);
    }
  });

  it("counts source-missing keys as failures and keeps going", async () => {
    const keys = await enumerateBlobKeys(t.ctx.router);
    const report = await copyMissing(
      fsStorage,
      s3Storage,
      [{ key: "zz/zz/never-existed", origin: "bogus" }, ...keys],
      { dryRun: false, log: quiet },
    );
    expect(report.failed).toBe(1);
    expect(report.skipped).toBe(3);
  });
});

describe("storage gc", () => {
  let t: TestApp;
  let cookie: string;
  let fake: FakeS3;
  const slug = "gc-proj";

  beforeAll(async () => {
    fake = await startFakeS3();
    t = await makeTestApp("shared", { s3: { endpoint: fake.url } });
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, name: "GC" }),
    });
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "gc me" }),
    });
  });

  afterAll(async () => {
    await t.cleanup();
    await fake.close();
  });

  async function requestDirect(filename: string, body: string) {
    const res = await t.app.request(
      `/api/projects/${slug}/attachments/direct-uploads`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          issue_number: 1,
          filename,
          content_type: "text/plain",
          size: body.length,
        }),
      },
    );
    expect(res.status).toBe(201);
    return json(res);
  }

  it("reaps orphans, keeps registered objects, drops settled rows", async () => {
    // Orphan WITH object: uploaded, never completed.
    const orphan = await requestDirect("orphan.txt", "orphan bytes");
    await fetch(orphan.url, { method: "PUT", body: "orphan bytes" });
    // Settled: uploaded and completed — its object is a real attachment.
    const settled = await requestDirect("settled.txt", "settled bytes");
    await fetch(settled.url, { method: "PUT", body: "settled bytes" });
    const done = await t.app.request(
      `/api/projects/${slug}/attachments/direct-uploads/${settled.upload_id}/complete`,
      { method: "POST", headers: { cookie } },
    );
    expect(done.status).toBe(201);
    // Orphan WITHOUT object: requested, never uploaded.
    await requestDirect("never.txt", "never sent");

    const objectsBefore = fake.objects.size;
    expect(objectsBefore).toBe(2);

    // Age every pending row past the reaping cutoff.
    const projectRow = (
      await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.slug, slug))
    )[0];
    if (!projectRow) throw new Error("project row missing");
    const db = await t.ctx.router.forProject({
      id: projectRow.id,
      slug,
      database_url: projectRow.databaseUrl,
    });
    await db
      .update(pendingUploads)
      .set({ expiresAt: new Date(Date.now() - 72 * 3600 * 1000) });

    const dry = await gcPendingUploads(t.ctx.router, t.ctx.storage, {
      dryRun: true,
      minAgeHours: 24,
      log: quiet,
    });
    expect(dry.wouldDelete).toBe(3);
    expect(fake.objects.size).toBe(objectsBefore);

    const real = await gcPendingUploads(t.ctx.router, t.ctx.storage, {
      dryRun: false,
      minAgeHours: 24,
      log: quiet,
    });
    expect(real.droppedRows).toBe(3);
    expect(real.deletedObjects).toBe(1);
    // The settled attachment's object survives.
    expect(fake.objects.size).toBe(1);
    const remaining = await db.select().from(pendingUploads);
    expect(remaining.length).toBe(0);
  });

  it("leaves fresh pending uploads alone", async () => {
    await requestDirect("fresh.txt", "still uploading");
    const report = await gcPendingUploads(t.ctx.router, t.ctx.storage, {
      dryRun: false,
      minAgeHours: 24,
      log: quiet,
    });
    expect(report.droppedRows).toBe(0);
  });
});
