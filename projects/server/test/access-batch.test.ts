import type { MemberRole } from "@todou/shared";
import { PROJECT_NOT_FOUND } from "@todou/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { UserRow } from "../src/auth/pat.ts";
import { projectMembers, slugHistory } from "../src/db/system-schema.ts";
import { ForbiddenError, NotFoundError } from "../src/errors.ts";
import {
  authorizeProjects,
  findProjectByRef,
  findProjectsByRefs,
  getProjectByRef,
  requireCapabilities,
  requireProject,
  rolesByProject,
} from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

type Actor = { user: UserRow; headers: { authorization: string } };

describe("batched project authorization", () => {
  let t: TestApp;
  let cookie: string;
  let reader: Actor;
  let outsider: Actor;
  let admin: Actor;
  /** Two projects the reader belongs to, and one they do not. */
  let memberIds: number[];
  let foreignId: number;

  const create = async (slug: string) => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: `Project ${slug}` }),
    });
    expect(res.status).toBe(201);
    return (await getProjectByRef(t.ctx, slug)).id;
  };

  const rename = async (from: string, to: string, reclaim = false) => {
    const res = await t.app.request(`/api/projects/${from}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug: to, ...(reclaim ? { reclaim } : {}) }),
    });
    expect(res.status).toBe(200);
  };

  const join = (projectId: number, user: UserRow, role: MemberRole) =>
    t.ctx.router
      .system()
      .insert(projectMembers)
      .values({ projectId, userId: user.id, role });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    reader = await addUserWithToken(t.ctx, "batch-reader");
    outsider = await addUserWithToken(t.ctx, "batch-outsider");
    admin = await addUserWithToken(t.ctx, "batch-admin", {
      instanceAdmin: true,
    });
    const a = await create("batch-a");
    const b = await create("batch-b");
    foreignId = await create("batch-foreign");
    memberIds = [a, b];
    await join(a, reader.user, "reader");
    await join(b, reader.user, "reader");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  describe("rolesByProject", () => {
    it("answers an instance admin without touching the database", async () => {
      const spy = vi.spyOn(t.ctx.router, "system");
      try {
        const roles = await rolesByProject(t.ctx, admin.user, [
          ...memberIds,
          foreignId,
        ]);
        expect(spy).not.toHaveBeenCalled();
        expect(roles).toEqual(
          new Map([...memberIds, foreignId].map((id) => [id, "admin"])),
        );
      } finally {
        spy.mockRestore();
      }
    });

    it("fills a non-member's project with null, in one query", async () => {
      const spy = vi.spyOn(t.ctx.router, "system");
      try {
        const roles = await rolesByProject(t.ctx, reader.user, [
          memberIds[0] as number,
          foreignId,
        ]);
        expect(roles).toEqual(
          new Map<number, MemberRole | null>([
            [memberIds[0] as number, "reader"],
            [foreignId, null],
          ]),
        );
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("asks nothing for an empty id list", async () => {
      const spy = vi.spyOn(t.ctx.router, "system");
      try {
        expect(await rolesByProject(t.ctx, reader.user, [])).toEqual(new Map());
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("findProjectsByRefs", () => {
    it("resolves every rung of the ladder exactly as the single-ref version", async () => {
      const renamedOnce = await create("ladder-one");
      await rename("ladder-one", "ladder-two");
      await rename("ladder-two", "ladder-three");
      // A reclaim: a second project takes the retired slug and then moves
      // off it, so "ladder-one" has two history rows and the newer wins.
      const reclaimer = await create("ladder-spare");
      await rename("ladder-spare", "ladder-one", true);
      await rename("ladder-one", "ladder-final");
      // Forced, not hoped for: PGlite's now() is millisecond-grained so the
      // two holders of "ladder-one" may or may not tie on their own, and a
      // tie is the only state in which the id tiebreak decides anything.
      await t.ctx.router
        .system()
        .update(slugHistory)
        .set({ effectiveFrom: new Date("2026-01-01T00:00:00.000Z") })
        .where(eq(slugHistory.slug, "ladder-one"));

      const refs = [
        "ladder-three",
        String(renamedOnce),
        "ladder-two",
        "ladder-one",
        "no-such",
        "99999999",
      ];
      const batch = await findProjectsByRefs(t.ctx, refs);
      for (const ref of refs) {
        expect([ref, batch.get(ref) ?? null]).toEqual([
          ref,
          await findProjectByRef(t.ctx, ref),
        ]);
      }
      expect(batch.get("ladder-one")?.project.id).toBe(reclaimer);
      expect(batch.get("ladder-two")?.project.id).toBe(renamedOnce);
      expect(batch.get(String(renamedOnce))?.viaAlias).toBe(true);
      expect(batch.get("ladder-three")?.viaAlias).toBe(false);
    });
  });

  describe("requireCapabilities", () => {
    it("reads the minimum role from the catalog and names the capability", async () => {
      await expect(
        requireCapabilities(
          t.ctx,
          reader.user,
          ["batch-a", "no-such"],
          "label.create",
        ),
      ).rejects.toThrow(ForbiddenError);
      await expect(
        requireCapabilities(t.ctx, reader.user, ["batch-a"], "label.create"),
      ).rejects.toThrow(/\(label\.create\)/);
    });

    it("raises the failure the argument order reaches first", async () => {
      await expect(
        requireCapabilities(
          t.ctx,
          reader.user,
          ["no-such", "batch-a"],
          "label.create",
        ),
      ).rejects.toThrow(NotFoundError);
    });

    it("gives a non-member the same 404 as a project that does not exist", async () => {
      await expect(
        requireCapabilities(
          t.ctx,
          reader.user,
          ["batch-foreign"],
          "inbox.read",
        ),
      ).rejects.toThrow(new NotFoundError(PROJECT_NOT_FOUND));
    });

    it("lets an instance admin through on one query", async () => {
      const spy = vi.spyOn(t.ctx.router, "system");
      try {
        const rows = await requireCapabilities(
          t.ctx,
          admin.user,
          ["batch-a", "batch-b", "batch-foreign"],
          "label.create",
        );
        expect(rows.map((row) => row.slug)).toEqual([
          "batch-a",
          "batch-b",
          "batch-foreign",
        ]);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("keeps one entry per ref, in order, duplicates included", async () => {
      const rows = await requireCapabilities(
        t.ctx,
        reader.user,
        ["batch-a", String(memberIds[0]), "batch-b", "batch-a"],
        "inbox.read",
      );
      expect(rows.map((row) => row.id)).toEqual([
        memberIds[0],
        memberIds[0],
        memberIds[1],
        memberIds[0],
      ]);
    });
  });

  describe("authorizeProjects", () => {
    it("turns a row the caller has no role on into a 404", async () => {
      const rows = await requireCapabilities(
        t.ctx,
        admin.user,
        ["batch-a"],
        "activity.read",
      );
      await expect(
        authorizeProjects(t.ctx, outsider.user, rows, "activity.read"),
      ).rejects.toThrow(new NotFoundError(PROJECT_NOT_FOUND));
    });
  });

  describe("requireProject", () => {
    it("checks membership before it checks the minimum it was handed", async () => {
      await expect(
        requireProject(
          t.ctx,
          outsider.user,
          "batch-a",
          "future-role" as MemberRole,
        ),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
