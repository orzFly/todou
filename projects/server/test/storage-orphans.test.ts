import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { Db } from "../src/db/driver.ts";
import { attachments, issues } from "../src/db/project-schema.ts";
import { blobReaps, projects } from "../src/db/system-schema.ts";
import {
  deleteOrphanBlobs,
  findOrphanBlobs,
  isMintedKey,
} from "../src/services/storage-admin.ts";
import { FsStorage } from "../src/storage/fs.ts";
import { S3Storage } from "../src/storage/s3.ts";
import type { StoredObject } from "../src/storage/types.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const HOUR = 3600 * 1000;

const mintedKey = (dir = "") => {
  const uuid = randomUUID();
  return `${dir}${uuid.slice(0, 2)}/${uuid.slice(2, 4)}/${uuid}`;
};

function s3Storage(fake: FakeS3, keyPrefix = ""): S3Storage {
  const config = loadConfig({
    tomlSource: [
      "[storage]",
      'backend = "s3"',
      "[storage.s3]",
      `endpoint = '${fake.url}'`,
      `bucket = '${fake.bucket}'`,
      "access_key_id = 'test-ak'",
      "secret_access_key = 'test-sk'",
      `key_prefix = '${keyPrefix}'`,
      "retries = 1",
      "request_timeout_ms = 2000",
    ].join("\n"),
    env: {},
  });
  if (!config.s3Credentials) throw new Error("credentials not resolved");
  return new S3Storage(config.storage.s3, config.s3Credentials);
}

async function all(list: AsyncIterable<StoredObject>): Promise<StoredObject[]> {
  const out: StoredObject[] = [];
  for await (const object of list) out.push(object);
  return out;
}

describe("StorageBackend.list", () => {
  let fake: FakeS3;

  beforeAll(async () => {
    fake = await startFakeS3();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("pages through s3 under the deployment's prefix, and strips it", async () => {
    fake.objects.clear();
    const keys = ["a/1", "a/2", "b/3", "c/4", "d/5"];
    for (const k of keys) fake.objects.set(`site/${k}`, Buffer.from(k));
    fake.objects.set("elsewhere/x", Buffer.from("not ours"));

    const listed = await all(s3Storage(fake, "site/").list({ pageSize: 2 }));

    expect(listed.map((o) => o.key)).toEqual(keys);
    expect(listed[0]?.size).toBe(3);
  });

  it("decodes XML escapes in s3 keys", async () => {
    fake.objects.clear();
    const odd = "odd/a&b<c>'d\"";
    fake.objects.set(odd, Buffer.from("x"));
    expect((await all(s3Storage(fake).list())).map((o) => o.key)).toEqual([
      odd,
    ]);
  });

  it("walks nested fs directories, keys joined with /", async () => {
    const root = testTmpDir("todou-list-");
    mkdirSync(join(root, "aa", "bb"), { recursive: true });
    writeFileSync(join(root, "aa", "bb", "deep"), "12345");
    writeFileSync(join(root, "top"), "1");
    const listed = await all(new FsStorage(root).list());
    expect(listed.map((o) => [o.key, o.size]).sort()).toEqual([
      ["aa/bb/deep", 5],
      ["top", 1],
    ]);
    expect(await all(new FsStorage(join(root, "missing")).list())).toEqual([]);
  });
});

describe("isMintedKey", () => {
  it("accepts the three shapes the server mints and nothing else", () => {
    expect(isMintedKey(mintedKey())).toBe(true);
    expect(isMintedKey(mintedKey("avatars/"))).toBe(true);
    expect(isMintedKey(mintedKey("project-icons/"))).toBe(true);
    const k = mintedKey();
    expect(isMintedKey(`zz/zz/${k.slice(6)}`)).toBe(false);
    expect(isMintedKey(`other/${k}`)).toBe(false);
    expect(isMintedKey(`${k}.bak`)).toBe(false);
  });
});

for (const backend of ["fs", "s3"] as const) {
  describe.each(PLACEMENTS)(
    `storage orphans on ${backend} (%s placement)`,
    (placement) => {
      let t: TestApp;
      let cookie: string;
      let fake: FakeS3 | undefined;
      /** Keys every check below expects to survive, by why they are known. */
      const keep: Record<string, string> = {};
      let liveDb: Db;
      let liveId = 0;
      let liveIssueId = 0;

      const api = (path: string, init?: RequestInit) =>
        t.app.request(`/api${path}`, {
          ...init,
          headers:
            typeof init?.body === "string"
              ? { "content-type": "application/json", cookie }
              : { cookie },
        });

      const exists = async (key: string) =>
        (await t.ctx.storage.head(key)) !== null;

      /** Push an object's modification time back, so only "known" can save it. */
      const age = (key: string, hours: number) => {
        const when = new Date(Date.now() - hours * HOUR);
        if (fake) fake.modified.set(key, when);
        else utimesSync(join(t.ctx.config.storage.path, key), when, when);
      };

      const putAged = async (key: string, hours = 48) => {
        await t.ctx.storage.put(key, new TextEncoder().encode(key));
        age(key, hours);
        return key;
      };

      async function createProject(slug: string) {
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
        const db = await t.ctx.router.forProject({
          id,
          slug,
          database_url: row?.databaseUrl ?? null,
        });
        const issue = await json(
          await api(`/projects/${slug}/issues`, {
            method: "POST",
            body: JSON.stringify({ title: "files" }),
          }),
        );
        return { id, db, issue: issue as { id: number; number: number } };
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
      }

      const keysIn = async (db: Db, projectId: number) =>
        (
          await db
            .select({ key: attachments.storageKey })
            .from(attachments)
            .where(eq(attachments.projectId, projectId))
        ).map((r) => r.key);

      beforeAll(async () => {
        if (backend === "s3") fake = await startFakeS3();
        t = await makeTestApp(
          placement,
          fake ? { s3: { endpoint: fake.url } } : undefined,
        );
        cookie = await t.login();
        const live = await createProject(`orphans-live-${placement}`);
        liveDb = live.db;
        liveId = live.id;
        liveIssueId = live.issue.id;
        await upload(`orphans-live-${placement}`, live.issue.number, "live");
        for (const k of await keysIn(live.db, live.id)) keep[k] = "attachment";

        // A card moved here from another project brings its key along.
        const from = await createProject(`orphans-from-${placement}`);
        await upload(`orphans-from-${placement}`, from.issue.number, "moved");
        const moved = await keysIn(from.db, from.id);
        const res = await api(
          `/projects/orphans-from-${placement}/issues/${from.issue.number}/move`,
          {
            method: "POST",
            body: JSON.stringify({ to_project: `orphans-live-${placement}` }),
          },
        );
        expect(res.status).toBe(200);
        for (const k of moved) keep[k] = "moved attachment";

        const avatar = new FormData();
        avatar.set("file", new File(["av"], "a.png", { type: "image/png" }));
        expect(
          (await api("/me/avatar", { method: "POST", body: avatar })).status,
        ).toBe(200);
        const icon = new FormData();
        icon.set("file", new File(["ic"], "i.png", { type: "image/png" }));
        expect(
          (
            await api(`/projects/orphans-live-${placement}/icon`, {
              method: "POST",
              body: icon,
            })
          ).status,
        ).toBe(200);

        if (fake) {
          const ticket = await json(
            await api(
              `/projects/orphans-live-${placement}/attachments/direct-uploads`,
              {
                method: "POST",
                body: JSON.stringify({
                  issue_number: live.issue.number,
                  filename: "t.txt",
                  content_type: "text/plain",
                  size: 6,
                }),
              },
            ),
          );
          const put = await fetch(ticket.url, {
            method: "PUT",
            body: "ticket",
          });
          expect(put.ok).toBe(true);
        }

        const pending = await putAged(mintedKey());
        await t.ctx.router
          .system()
          .insert(blobReaps)
          .values({
            key: pending,
            kind: "upload",
            projectId: 987_654,
            deleteAfter: new Date(Date.now() + HOUR),
          });
        keep[pending] = "listed for the reaper";
        keep[await putAged("not/a/minted/key")] = "foreign shape";
        keep[await putAged(mintedKey(), 1)] = "younger than --min-age";

        // Everything above that exists in storage, now old enough to be
        // judged by whether something names it.
        for await (const object of t.ctx.storage.list()) {
          if (keep[object.key] === "younger than --min-age") continue;
          if (!keep[object.key]) keep[object.key] = "named by a database";
          age(object.key, 48);
        }
      });

      afterAll(async () => {
        await t.cleanup();
        await fake?.close();
      });

      it("finds an orphan and none of what a database names", async () => {
        const orphan = await putAged(mintedKey());

        const found = await findOrphanBlobs(t.ctx.router, t.ctx.storage, {
          minAgeHours: 24,
        });

        expect(found.map((o) => o.key)).toEqual([orphan]);
        expect(Object.values(keep)).toEqual(
          expect.arrayContaining([
            "attachment",
            "moved attachment",
            "listed for the reaper",
            "foreign shape",
            "younger than --min-age",
          ]),
        );
        // The avatar and the icon, plus the ticket's upload key on s3.
        expect(
          Object.values(keep).filter((v) => v === "named by a database").length,
        ).toBe(fake ? 3 : 2);
        // Listing deletes nothing.
        expect(await exists(orphan)).toBe(true);
        await t.ctx.storage.delete(orphan);
      });

      it("deletes the orphans, and only them", async () => {
        const orphan = await putAged(mintedKey());
        const found = await findOrphanBlobs(t.ctx.router, t.ctx.storage, {
          minAgeHours: 24,
        });

        const report = await deleteOrphanBlobs(
          t.ctx.router,
          t.ctx.storage,
          found,
          { log: () => {} },
        );

        expect(report).toEqual({ deleted: 1, skipped: 0, failed: 0 });
        expect(await exists(orphan)).toBe(false);
        for (const key of Object.keys(keep)) {
          expect([key, await exists(key)]).toEqual([key, true]);
        }
      });

      it("spares an orphan that a database names by the time of the delete", async () => {
        const orphan = await putAged(mintedKey());
        const found = await findOrphanBlobs(t.ctx.router, t.ctx.storage, {
          minAgeHours: 24,
        });
        expect(found.map((o) => o.key)).toEqual([orphan]);
        const [card] = await liveDb
          .select({ authorId: issues.authorId })
          .from(issues)
          .where(and(eq(issues.id, liveIssueId)));
        await liveDb.insert(attachments).values({
          projectId: liveId,
          issueId: liveIssueId,
          uploaderId: card?.authorId ?? 1,
          filename: `late-${orphan.slice(-6)}.txt`,
          contentType: "text/plain",
          size: 1,
          storageKey: orphan,
        });

        const report = await deleteOrphanBlobs(
          t.ctx.router,
          t.ctx.storage,
          found,
          { log: () => {} },
        );

        expect(report).toEqual({ deleted: 0, skipped: 1, failed: 0 });
        expect(await exists(orphan)).toBe(true);
      });

      it("refuses to judge while a project database cannot be read", async () => {
        const orphan = await putAged(mintedKey());
        const [broken] = await t.ctx.router
          .system()
          .insert(projects)
          .values({
            slug: `orphans-unreadable-${placement}`,
            name: "unreadable",
            databaseUrl: "postgres://127.0.0.1:1/nope",
          })
          .returning();
        try {
          await expect(
            findOrphanBlobs(t.ctx.router, t.ctx.storage, { minAgeHours: 24 }),
          ).rejects.toThrow();
          await expect(
            deleteOrphanBlobs(
              t.ctx.router,
              t.ctx.storage,
              [{ key: orphan, size: 1, modifiedAt: new Date(0) }],
              { log: () => {} },
            ),
          ).rejects.toThrow();
          expect(await exists(orphan)).toBe(true);
        } finally {
          await t.ctx.router
            .system()
            .delete(projects)
            .where(eq(projects.id, broken?.id ?? -1));
          await t.ctx.storage.delete(orphan);
        }
      });
    },
  );
}
