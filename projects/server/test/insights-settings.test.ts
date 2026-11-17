import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insightsSettings } from "../src/db/project-schema.ts";
import { getProjectByRef, routeInfoOf } from "../src/services/access.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

const json = (response: Response): Promise<unknown> => response.json();

describe.each(PLACEMENTS)("insights settings (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let projectId: number;
  const slug = `insights-settings-${placement}`;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(created.status).toBe(201);
    const body = (await json(created)) as { id: number };
    projectId = body.id;
  });

  afterAll(async () => t.cleanup());

  it("derives defaults without writing and atomically saves a complete map", async () => {
    const first = await t.app.request(
      `/api/projects/${slug}/insights/settings`,
      {
        headers: { cookie },
      },
    );
    expect(first.status).toBe(200);
    const settings = (await json(first)) as {
      version: string;
      source: string;
      roles: Array<{ status_id: number; name: string; role: string }>;
    };
    expect(settings.source).toBe("default");
    expect(settings.roles.find((role) => role.name === "Shipped")?.role).toBe(
      "completed",
    );
    expect(settings.roles.find((role) => role.name === "Done")?.role).toBe(
      "completed",
    );
    expect(settings.roles.find((role) => role.name === "Invalid")?.role).toBe(
      "excluded",
    );

    const route = await getProjectByRef(t.ctx, slug);
    const db = await t.ctx.router.forProject(routeInfoOf(route));
    expect(
      await db
        .select({ value: count() })
        .from(insightsSettings)
        .where(eq(insightsSettings.projectId, projectId)),
    ).toEqual([{ value: 0 }]);

    const roles = settings.roles.map(({ status_id }, index) => ({
      status_id,
      role: index === 0 ? "excluded" : "completed",
    }));
    const save = () =>
      t.app.request(`/api/projects/${slug}/insights/settings`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ version: settings.version, roles }),
      });
    const contenders = await Promise.all([save(), save()]);
    expect(contenders.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const saved = contenders.find((response) => response.status === 200);
    if (!saved) throw new Error("concurrent settings save had no winner");
    const savedBody = (await json(saved)) as {
      source: string;
      version: string;
    };
    expect(savedBody.source).toBe("saved");
    expect(savedBody.version).not.toBe(settings.version);
  });

  it("rejects incomplete, duplicate, and foreign status mappings", async () => {
    const current = (await json(
      await t.app.request(`/api/projects/${slug}/insights/settings`, {
        headers: { cookie },
      }),
    )) as {
      version: string;
      roles: Array<{ status_id: number; role: string }>;
    };
    for (const roles of [
      current.roles.slice(1),
      [current.roles[0], current.roles[0], ...current.roles.slice(1)],
      [...current.roles, { status_id: 999_999, role: "remaining" }],
    ]) {
      const response = await t.app.request(
        `/api/projects/${slug}/insights/settings`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ version: current.version, roles }),
        },
      );
      expect([400, 422]).toContain(response.status);
      const body = (await json(response)) as { error: { code: string } };
      expect(body.error.code).toBe("validation_failed");
    }
  });
});

describe.each(PLACEMENTS)(
  "one status's insights role T-712 (%s placement)",
  (placement) => {
    let t: TestApp;
    let cookie: string;
    const slug = `insights-role-${placement}`;
    type Body = {
      version: string;
      source: string;
      roles: Array<{ status_id: number; name: string; role: string }>;
    };

    const read = async (): Promise<Body> =>
      (await json(
        await t.app.request(`/api/projects/${slug}/insights/settings`, {
          headers: { cookie },
        }),
      )) as Body;
    const setRole = (
      statusId: number,
      role: string,
      who: Record<string, string> = { cookie },
    ) =>
      t.app.request(
        `/api/projects/${slug}/insights/settings/roles/${statusId}`,
        {
          method: "PUT",
          headers: { ...who, "content-type": "application/json" },
          body: JSON.stringify({ role }),
        },
      );
    const idOf = (body: Body, name: string) =>
      body.roles.find((entry) => entry.name === name)?.status_id as number;
    const roleOf = (body: Body, name: string) =>
      body.roles.find((entry) => entry.name === name)?.role;

    beforeAll(async () => {
      t = await makeTestApp(placement);
      cookie = await t.login();
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
    });

    afterAll(async () => t.cleanup());

    it("sets one key, leaves the rest on their defaults, bumps only on change", async () => {
      const before = await read();
      const next = idOf(before, "Next");

      const first = await setRole(next, "excluded");
      expect(first.status).toBe(200);
      const saved = (await json(first)) as Body;
      expect(saved.source).toBe("saved");
      expect(roleOf(saved, "Next")).toBe("excluded");
      expect(roleOf(saved, "Done")).toBe("completed");
      expect(roleOf(saved, "Invalid")).toBe("excluded");
      expect(roleOf(saved, "Todo")).toBe("remaining");
      expect(saved).toEqual(await read());

      const repeat = (await json(await setRole(next, "excluded"))) as Body;
      expect(repeat.version).toBe(saved.version);

      const changed = (await json(await setRole(next, "completed"))) as Body;
      expect(changed.version).not.toBe(saved.version);
      expect(roleOf(changed, "Next")).toBe("completed");

      // The whole-mapping PUT still works on top of a per-status write.
      const whole = await t.app.request(
        `/api/projects/${slug}/insights/settings`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            version: changed.version,
            roles: changed.roles.map(({ status_id }) => ({
              status_id,
              role: "remaining",
            })),
          }),
        },
      );
      expect(whole.status).toBe(200);
      expect(roleOf((await json(whole)) as Body, "Next")).toBe("remaining");
    });

    it("stores a key the first time even when it equals the default", async () => {
      // A status created after the whole-mapping PUT above has no stored key.
      const created = await t.app.request(`/api/projects/${slug}/statuses`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Fresh", category: "open" }),
      });
      expect(created.status).toBe(201);
      const before = await read();
      expect(roleOf(before, "Fresh")).toBe("remaining");
      const response = await setRole(idOf(before, "Fresh"), "remaining");
      expect(response.status).toBe(200);
      expect(((await json(response)) as Body).version).not.toBe(before.version);
    });

    it("is 404 for a status outside the project, 403 without status.manage", async () => {
      expect((await setRole(999_999, "excluded")).status).toBe(404);

      const writer = await addUserWithToken(t.ctx, `role-writer-${placement}`);
      const add = await t.app.request(
        `/api/projects/${slug}/members/${writer.user.id}`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ role: "writer" }),
        },
      );
      expect(add.status).toBe(204);
      const next = idOf(await read(), "Next");
      expect((await setRole(next, "excluded", writer.headers)).status).toBe(
        403,
      );
    });
  },
);
