import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { routeInfoOf } from "../src/services/access.ts";
import { checkFilenameMigration } from "./attachment-migration-cases.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * 0013 is three SQL statements, including a plpgsql block and an expression
 * index; PGlite passing them says nothing about the server that will actually
 * run the upgrade. Runs only when TODOU_TEST_POSTGRES_URL points at a live
 * server:
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test attachment-migration-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)(
  "0013 attachment filename migration on postgres",
  () => {
    let t: TestApp;
    // The database persists across runs; a unique slug isolates each one.
    const slug = `mig-names-pg-${Date.now().toString(36)}`;

    beforeAll(async () => {
      t = await makeTestApp("shared", { systemUrl: PG_URL });
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
          body: JSON.stringify({ slug, name: "Migration (postgres)" }),
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
        .where(eq(issues.projectId, project.id));

      await checkFilenameMigration(db, {
        projectId: project.id,
        issueId: (issue as { id: number }).id,
        uploaderId: me.id,
      });
    });
  },
);
