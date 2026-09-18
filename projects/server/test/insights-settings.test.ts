import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insightsSettings } from "../src/db/project-schema.ts";
import { getProjectByRef, routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

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
    const invalid = await t.app.request(`/api/projects/${slug}/statuses`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Invalid",
        category: "closed",
        color: "#999999",
      }),
    });
    expect(invalid.status).toBe(201);
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
