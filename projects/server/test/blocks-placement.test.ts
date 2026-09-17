import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getProjectByRef, routeInfoOf } from "../src/services/access.ts";
import { makeTestApp, PLACEMENTS } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/** Does this database hold `table`.`column` (or the table at all)? */
async function has(
  // biome-ignore lint/suspicious/noExplicitAny: driver-agnostic Db handle
  db: any,
  table: string,
  column?: string,
): Promise<boolean> {
  const rows = await db.execute(
    column === undefined
      ? sql`select 1 from information_schema.tables
             where table_name = ${table}`
      : sql`select 1 from information_schema.columns
             where table_name = ${table} and column_name = ${column}`,
  );
  return (rows.rows ?? rows).length > 0;
}

describe("block storage lands in the right tier T-377", () => {
  it.each(PLACEMENTS)("builds a project under %s placement", async (mode) => {
    const t = await makeTestApp(mode);
    try {
      const cookie = await t.login();
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slug: "tier", name: "Tier" }),
      });
      expect(res.status).toBe(201);
      const created = await json(res);
      expect(created.slug).toBe("tier");
    } finally {
      await t.cleanup();
    }
  });

  // The whole design rests on this split: the edges answer "who points at me"
  // across the deployment, so they are system-tier; the clear line names a
  // status row, so it sits beside it. Under `dedicated` the two are in
  // different databases, which is the only placement that can tell them apart.
  it("keeps the edges in the system db and the clear line in the project db", async () => {
    const t = await makeTestApp("dedicated");
    try {
      const cookie = await t.login();
      expect(
        (
          await t.app.request("/api/projects", {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ slug: "tier-split", name: "Split" }),
          })
        ).status,
      ).toBe(201);
      const project = await getProjectByRef(t.ctx, "tier-split");
      const system = t.ctx.router.system();
      const db = await t.ctx.router.forProject(routeInfoOf(project));

      expect(await has(system, "issue_blocks")).toBe(true);
      expect(await has(db, "issue_blocks")).toBe(false);
      expect(await has(db, "project_meta", "block_clear_status_id")).toBe(true);
      expect(await has(system, "project_meta", "block_clear_status_id")).toBe(
        false,
      );
    } finally {
      await t.cleanup();
    }
  });
});
