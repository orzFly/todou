import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessibleProjectRows } from "../src/services/access.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * `GET /api/users/{ref}/issues` against a real server, which is the only
 * place its new shape is fully exercised: no other postgres suite calls this
 * endpoint, and PGlite cannot speak to how node-postgres types the VALUES
 * parameters, plans a correlated LATERAL, or decodes int8.
 *
 *   TODOU_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:54329/postgres \
 *     pnpm --filter @todou/server test user-issues-postgres
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  Array.isArray(result)
    ? result
    : ((result as { rows: Array<Record<string, unknown>> }).rows ?? []);

describe.skipIf(!PG_URL)("user issues on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  let subject: Awaited<ReturnType<typeof addUserWithToken>>;
  // The database persists across runs; unique slugs isolate each one.
  const run = Date.now().toString(36);
  const slugs = [`ui-pg-a-${run}`, `ui-pg-b-${run}`];
  const projectIds: number[] = [];

  const list = async (params: Record<string, string>) => {
    const res = await t.app.request(
      `/api/users/${subject.user.login}/issues?${new URLSearchParams(params)}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    return json(res);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const headers = { "content-type": "application/json", cookie };
    subject = await addUserWithToken(t.ctx, `ui-pg-subject-${run}`);
    for (const slug of slugs) {
      const created = await t.app.request("/api/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(created.status).toBe(201);
      const member = await t.app.request(
        `/api/projects/${slug}/members/${subject.user.id}`,
        { method: "PUT", headers, body: JSON.stringify({ role: "writer" }) },
      );
      expect(member.status).toBe(204);
      for (const title of ["first card", "second card"]) {
        const issue = await t.app.request(`/api/projects/${slug}/issues`, {
          method: "POST",
          headers: { "content-type": "application/json", ...subject.headers },
          body: JSON.stringify({ title }),
        });
        expect(issue.status).toBe(201);
      }
    }
    for (const row of await accessibleProjectRows(t.ctx, subject.user)) {
      if (slugs.includes(row.slug)) projectIds.push(row.id);
    }
    expect(projectIds).toHaveLength(2);
  }, 120_000);

  afterAll(async () => {
    await t.cleanup();
  });

  it("answers both projects in one page", async () => {
    // The gate on whether the new statement runs on node-postgres at all:
    // the VALUES parameters have to take a type, the LATERAL has to plan,
    // and `+ interval '1 microsecond'` has to be a legal cell value.
    const page = await list({ limit: "100" });
    expect(page.items).toHaveLength(4);
  });

  it("pages over every card exactly once at limit=1", async () => {
    // Real postgres stamps `updated_at` with microseconds, so these cursors
    // carry the sub-millisecond digits the window rule is built around —
    // the half of `listCursorBounds` PGlite's millisecond clock never
    // reaches.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body = await list({
        limit: "1",
        ...(cursor === null ? {} : { after: cursor }),
      });
      for (const item of body.items as {
        number: number;
        project: { slug: string };
      }[]) {
        seen.push(`${item.project.slug}/${item.number}`);
      }
      cursor = body.next_cursor as string | null;
      if (!body.has_more) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it("hands back numbers, not int8 strings", async () => {
    const page = await list({ limit: "100" });
    for (const item of page.items as {
      number: unknown;
      project: { id: unknown };
    }[]) {
      expect(typeof item.number).toBe("number");
      expect(typeof item.project.id).toBe("number");
    }
  });

  it("collects the candidate query's plan", async () => {
    // Printed, not asserted: under the default placement this LATERAL is the
    // only read the endpoint makes, so a plan that degenerates does it
    // against the caller's entire readable set at once. Which plan postgres
    // picks is a cost decision that moves with table size; the record is for
    // the eye that reads the batch's output.
    const [a, b] = projectIds as [number, number];
    const plan = rowsOf(
      await t.ctx.router.system().execute(sql`
        explain select hit.* from (values
          (${a}::bigint, null::timestamptz, null::timestamptz, null::bigint),
          (${b}::bigint, ${"2033-01-01T00:00:00.000321Z"}::timestamptz,
           ${"2033-01-01T00:00:00.000321Z"}::timestamptz + interval '1 microsecond',
           ${2 ** 31}::bigint)
        ) as scope(project_id, after_from, after_hi, after_id)
        cross join lateral (
          select i.id, i.updated_at from issues i
          inner join statuses s on s.id = i.status_id
          where i.project_id = scope.project_id
            and i.deleted_at is null and i.moved_at is null
            and i.author_id = ${subject.user.id}
            and (scope.after_from is null
                 or i.updated_at < scope.after_from
                 or (i.updated_at >= scope.after_from
                     and i.updated_at < scope.after_hi
                     and i.id < scope.after_id))
          order by i.updated_at desc, i.id desc limit 31
        ) hit
      `),
    )
      .map((r) => String(r["QUERY PLAN"]))
      .join("\n");
    // stderr, because vitest's reporter swallows stdout from a passing file.
    // No assertion on the plan's content on purpose — see above.
    console.warn(`user-issues candidate plan:\n${plan}`);
  });
});
