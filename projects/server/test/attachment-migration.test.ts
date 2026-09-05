import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { checkFilenameMigration } from "./attachment-migration-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe("0013 attachment filename migration", () => {
  let t: TestApp;
  const slug = "mig-names";

  beforeAll(async () => {
    t = await makeTestApp("dedicated");
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("renames clashing and clipboard-default names, then locks the index", async () => {
    const cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    const project = await json(
      await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, name: "Migration" }),
      }),
    );
    await t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "with clashing files" }),
    });
    const me = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );

    const db = await t.ctx.router.forProject(
      routeInfoOf({
        id: project.id,
        slug,
        databaseUrl: null,
      } as Parameters<typeof routeInfoOf>[0]),
    );
    const [issue] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.number, 1));

    await checkFilenameMigration(db, {
      projectId: project.id,
      issueId: (issue as { id: number }).id,
      uploaderId: me.id,
    });
  });
});
