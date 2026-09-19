import type { MemberRole } from "@todou/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import { projectMembers } from "../src/db/system-schema.ts";
import { ForbiddenError } from "../src/errors.ts";
import { getProjectByRef, requireProject } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

describe("role gate fallback boundaries", () => {
  let t: TestApp;
  let actor: { user: UserRow; headers: { authorization: string } };
  let projectId: number;
  let cookie: string;
  const slug = "role-fallbacks";

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: "Role fallbacks" }),
    });
    expect(created.status).toBe(201);
    projectId = (await getProjectByRef(t.ctx, slug)).id;
    actor = await addUserWithToken(t.ctx, "role-probe");
    await t.ctx.router.system().insert(projectMembers).values({
      projectId,
      userId: actor.user.id,
      role: "reader",
    });
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("refuses an unknown local minimum and does not treat it as the reader floor", async () => {
    await expect(
      requireProject(t.ctx, actor.user, slug, "reader"),
    ).resolves.toMatchObject({ role: "reader" });
    for (const minimum of ["future-role", "constructor", undefined]) {
      await expect(
        requireProject(t.ctx, actor.user, slug, minimum as MemberRole),
      ).rejects.toThrow(TypeError);
    }
  });

  it("refuses an unknown stored role at both read and write gates", async () => {
    try {
      for (const role of ["future-role", "constructor", "__proto__"]) {
        await t.ctx.router
          .system()
          .update(projectMembers)
          .set({ role: role as MemberRole })
          .where(
            and(
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, actor.user.id),
            ),
          );
        for (const minimum of ["reader", "writer", "admin"] as const) {
          await expect(
            requireProject(t.ctx, actor.user, slug, minimum),
          ).rejects.toThrow(ForbiddenError);
        }
        const response = await t.app.request(`/api/projects/${slug}/issues`, {
          method: "POST",
          headers: { ...actor.headers, "content-type": "application/json" },
          body: JSON.stringify({ title: "must not be created" }),
        });
        expect(response.status).toBe(403);
      }
    } finally {
      await t.ctx.router
        .system()
        .update(projectMembers)
        .set({ role: "reader" })
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, actor.user.id),
          ),
        );
    }
  });

  it("rejects unknown desired roles at the schema boundary before granting membership", async () => {
    const response = await t.app.request(
      `/api/projects/${slug}/members/${actor.user.id}`,
      {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ role: "future-role" }),
      },
    );
    expect(response.status).toBe(422);
    await expect(
      requireProject(t.ctx, actor.user, slug, "reader"),
    ).resolves.toMatchObject({ role: "reader" });
  });
});
