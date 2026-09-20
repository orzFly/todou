import { randomUUID } from "node:crypto";
import type { Member, Project } from "@todou/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectMembers } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;
const BACKENDS = [
  { name: "PGlite", systemUrl: undefined },
  { name: "PostgreSQL", systemUrl: PG_URL },
] as const;

for (const backend of BACKENDS) {
  describe.skipIf(backend.name === "PostgreSQL" && !PG_URL)(
    `member list ordering (${backend.name})`,
    () => {
      let t: TestApp;
      let adminHeaders: Record<string, string>;
      const tag = `memorder-${randomUUID()}`;
      let seq = 0;
      const sending = (headers: Record<string, string>) => ({
        "content-type": "application/json",
        ...headers,
      });

      beforeAll(async () => {
        t = await makeTestApp("shared", { systemUrl: backend.systemUrl });
        const admin = await addUserWithToken(t.ctx, `${tag}-admin`, {
          instanceAdmin: true,
        });
        adminHeaders = admin.headers;
      });

      afterAll(async () => {
        await t?.cleanup();
      });

      async function seed(
        times: [string, string, string],
        insertionOrder: (0 | 1 | 2)[],
      ) {
        const slug = `${tag}-${seq++}`;
        const response = await t.app.request("/api/projects", {
          method: "POST",
          headers: sending(adminHeaders),
          body: JSON.stringify({ slug, name: slug }),
        });
        expect(response.status).toBe(201);
        const project = (await response.json()) as Project;
        // Allocate ids in ascending order, independently of membership inserts.
        const actors = [
          await addUserWithToken(t.ctx, `${slug}-alice`),
          await addUserWithToken(t.ctx, `${slug}-bob`),
          await addUserWithToken(t.ctx, `${slug}-carol`),
        ] as const;
        const db = t.ctx.router.system();
        await db
          .delete(projectMembers)
          .where(eq(projectMembers.projectId, project.id));
        for (const index of insertionOrder) {
          await db.insert(projectMembers).values({
            projectId: project.id,
            userId: actors[index].user.id,
            role: index === 0 ? "admin" : "writer",
            createdAt: new Date(times[index]),
          });
        }
        return { slug, actors };
      }

      async function list(slug: string): Promise<Member[]> {
        const response = await t.app.request(`/api/projects/${slug}/members`, {
          headers: adminHeaders,
        });
        expect(response.status).toBe(200);
        return (await response.json()) as Member[];
      }

      const early = "2025-01-01T00:00:00.000Z";
      const middle = "2025-01-02T00:00:00.000Z";
      const late = "2025-01-03T00:00:00.000Z";

      it("orders by join time against insertion, id and name order", async () => {
        // Both heap insertion and the membership primary key favor alice first;
        // join time must put carol first. Dropping ORDER BY reverses the result.
        const { slug, actors } = await seed([late, middle, early], [0, 1, 2]);
        const rows = await list(slug);
        expect(rows.map((row) => row.user.id)).toEqual([
          actors[2].user.id,
          actors[1].user.id,
          actors[0].user.id,
        ]);
        expect(rows.map((row) => row.created_at)).toEqual([
          early,
          middle,
          late,
        ]);
      });

      it("breaks equal join times by user id against insertion order", async () => {
        const { slug, actors } = await seed([early, early, early], [2, 1, 0]);
        const rows = await list(slug);
        expect(rows.map((row) => row.user.id)).toEqual(
          actors.map((actor) => actor.user.id),
        );
        expect(rows.map((row) => row.created_at)).toEqual([
          early,
          early,
          early,
        ]);
      });

      it("keeps join order after a role change and a profile rename", async () => {
        const { slug, actors } = await seed([late, middle, early], [0, 1, 2]);
        const before = await list(slug);
        const member = actors[1];
        const role = await t.app.request(
          `/api/projects/${slug}/members/${member.user.id}`,
          {
            method: "PUT",
            headers: sending(adminHeaders),
            body: JSON.stringify({ role: "reader" }),
          },
        );
        expect(role.status).toBe(204);
        const profile = await t.app.request("/api/me", {
          method: "PATCH",
          headers: sending(member.headers),
          body: JSON.stringify({
            login: `${slug}-aardvark`,
            display_name: "Aardvark",
          }),
        });
        expect(profile.status).toBe(200);
        const after = await list(slug);
        expect(after.map((row) => row.user.id)).toEqual([
          actors[2].user.id,
          member.user.id,
          actors[0].user.id,
        ]);
        expect(after.map((row) => row.created_at)).toEqual(
          before.map((row) => row.created_at),
        );
        expect(after[1]).toMatchObject({
          user: { login: `${slug}-aardvark`, display_name: "Aardvark" },
          role: "reader",
        });
      });
    },
  );
}
