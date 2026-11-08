import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/driver.ts";
import {
  attachments,
  issues,
  pendingUploads,
} from "../src/db/project-schema.ts";
import { projects } from "../src/db/system-schema.ts";
import { runHousekeepingTick } from "../src/services/housekeeping.ts";
import { type FakeS3, startFakeS3 } from "./fake-s3.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * A ticket keeps accepting PUTs until it expires, whatever happens to the
 * card it was issued for. Moving the card must not take away the row that
 * is the only inventory of what the ticket writes (T-671).
 */
describe.each(PLACEMENTS)(
  "direct uploads on a moved card (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    let fake: FakeS3;
    const A = `dum-a-${placement}`;
    const B = `dum-b-${placement}`;

    beforeAll(async () => {
      fake = await startFakeS3();
      t = await makeTestApp(placement, { s3: { endpoint: fake.url } });
      cookie = await t.login();
      for (const slug of [A, B]) {
        const res = await api("/projects", {
          method: "POST",
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(res.status).toBe(201);
      }
    });

    afterAll(async () => {
      await t.cleanup();
      await fake.close();
    });

    const api = (path: string, init?: RequestInit) =>
      t.app.request(`/api${path}`, {
        ...init,
        headers: init?.body
          ? { "content-type": "application/json", cookie }
          : { cookie },
      });

    async function createIssue(slug: string, title: string): Promise<number> {
      const res = await api(`/projects/${slug}/issues`, {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return (await json(res)).number;
    }

    async function ticketFor(slug: string, number: number, body: string) {
      const res = await api(`/projects/${slug}/attachments/direct-uploads`, {
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

    const complete = (slug: string, uploadId: number) =>
      api(`/projects/${slug}/attachments/direct-uploads/${uploadId}/complete`, {
        method: "POST",
      });

    async function move(from: string, number: number, to: string) {
      const res = await api(`/projects/${from}/issues/${number}/move`, {
        method: "POST",
        body: JSON.stringify({ to_project: to }),
      });
      expect(res.status).toBe(200);
      return (await json(res)).moved_to.number as number;
    }

    const holding = (body: string) =>
      [...fake.objects.values()].filter((b) => b.toString() === body);

    async function expireAll(slug: string) {
      const db = await projectDb(t, slug);
      await db
        .update(pendingUploads)
        .set({ expiresAt: new Date(Date.now() - 72 * 3600 * 1000) });
    }

    it("collects an upload sent before the move and never completed", async () => {
      const number = await createIssue(A, "in flight");
      const ticket = await ticketFor(A, number, "in flight bytes");
      await put(ticket.url, "in flight bytes");
      await move(A, number, B);

      // The card is gone from here; completing names the move, not a 404.
      const late = await complete(A, ticket.upload_id);
      expect(late.status).toBe(409);
      expect((await json(late)).error.code).toBe("issue_moved");
      expect(holding("in flight bytes")).toHaveLength(1);

      await expireAll(A);
      await runHousekeepingTick(t.ctx);

      expect(holding("in flight bytes")).toHaveLength(0);
    });

    it("collects a replay after the move of an upload completed before it", async () => {
      const number = await createIssue(A, "completed then moved");
      const ticket = await ticketFor(A, number, "replay bytes");
      await put(ticket.url, "replay bytes");
      expect((await complete(A, ticket.upload_id)).status).toBe(201);
      const landed = await move(A, number, B);

      await put(ticket.url, "replay bytes");
      expect(holding("replay bytes")).toHaveLength(2);

      await expireAll(A);
      await runHousekeepingTick(t.ctx);

      // The attachment's own copy, carried along with the card, survives.
      expect(holding("replay bytes")).toHaveLength(1);
      const dbB = await projectDb(t, B);
      const [issueB] = await dbB
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.number, landed));
      const carried = await dbB
        .select({ key: attachments.storageKey })
        .from(attachments)
        .where(eq(attachments.issueId, issueB?.id ?? -1));
      expect(carried).toHaveLength(1);
      expect(fake.objects.get(carried[0]?.key ?? "")?.toString()).toBe(
        "replay bytes",
      );
    });

    it("keeps the row through a move there and back", async () => {
      const number = await createIssue(A, "round trip");
      const ticket = await ticketFor(A, number, "round trip bytes");
      const there = await move(A, number, B);
      await move(B, there, A);
      await put(ticket.url, "round trip bytes");

      await expireAll(A);
      await runHousekeepingTick(t.ctx);

      expect(holding("round trip bytes")).toHaveLength(0);
    });

    it("leaves an unexpired row on the tombstone to the reaper", async () => {
      const number = await createIssue(A, "still in window");
      const ticket = await ticketFor(A, number, "window bytes");
      await put(ticket.url, "window bytes");
      await move(A, number, B);

      await runHousekeepingTick(t.ctx);

      expect(holding("window bytes")).toHaveLength(1);
      const db = await projectDb(t, A);
      const row = await db
        .select()
        .from(pendingUploads)
        .where(eq(pendingUploads.id, ticket.upload_id));
      expect(row).toHaveLength(1);
    });

    it("deletes a project whose tombstones still hold upload rows", async () => {
      const C = `dum-c-${placement}`;
      const created = await api("/projects", {
        method: "POST",
        body: JSON.stringify({ slug: C, name: C }),
      });
      expect(created.status).toBe(201);
      const number = await createIssue(C, "leaves with rows behind");
      const ticket = await ticketFor(C, number, "doomed bytes");
      await put(ticket.url, "doomed bytes");
      const landed = await move(C, number, B);
      const dbC = await projectDb(t, C);

      const res = await api(`/projects/${C}`, { method: "DELETE" });
      expect(res.status).toBe(204);

      if (placement === "shared") {
        const left = await dbC
          .select()
          .from(pendingUploads)
          .where(eq(pendingUploads.id, ticket.upload_id));
        expect(left).toEqual([]);
      }
      const view = await api(`/projects/${B}/issues/${landed}`);
      expect(view.status).toBe(200);
    });
  },
);

async function projectDb(t: TestApp, slug: string): Promise<Db> {
  const row = (
    await t.ctx.router
      .system()
      .select()
      .from(projects)
      .where(eq(projects.slug, slug))
  )[0];
  if (!row) throw new Error("project row missing");
  return t.ctx.router.forProject({
    id: row.id,
    slug,
    database_url: row.databaseUrl,
  });
}
