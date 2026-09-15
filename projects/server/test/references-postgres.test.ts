import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The reference-format HTTP surface against a real postgres: setting the
 * format, reading the config back, and the system-side mirror the reference
 * directory is built from. Every other suite driving those endpoints meets
 * PGlite only, so the SQL, the indexes and the timestamp round-trip here are
 * the server's rather than the WASM bundle's — that difference, not
 * timestamp precision, is what this gate buys. The one comparison where
 * microsecond precision lands on both sides is the T-266 rewrite's, and
 * refs-migrate.test.ts covers it. Runs only when TODOU_TEST_POSTGRES_URL
 * points at a live server (see issue-list-postgres.test.ts).
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("reference format on real postgres", () => {
  let t: TestApp;
  let cookie: string;
  const slug = `refs-pg-${Date.now().toString(36)}`;

  const api = (path: string, init?: RequestInit) =>
    t.app.request(`/api/projects/${slug}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        cookie,
        ...(init?.headers ?? {}),
      },
    });

  beforeAll(async () => {
    t = await makeTestApp("shared", { systemUrl: PG_URL });
    cookie = await t.login();
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug, name: "Reference format (postgres)" }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function createIssue(
    title: string,
    body = "",
  ): Promise<{ number: number }> {
    const res = await api("/issues", {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  async function referencedCount(number: number): Promise<number> {
    const page = await json(
      await api(`/issues/${number}/timeline?types=referenced&limit=100`),
    );
    return page.items.length;
  }

  it("keeps back-to-back writes on the correct side of a switch", async () => {
    const target = await createIssue("target");

    // Writes packed as tightly as the API allows around the switch, so
    // nothing but the switch separates them: each has to resolve under the
    // format in force when it was submitted, never under its neighbour's.
    const before = await createIssue("before", `pre #${target.number}`);
    const put = await api("/references/format", {
      method: "PUT",
      body: JSON.stringify({ prefix: "T" }),
    });
    expect(put.status).toBe(200);
    const after = await createIssue("after", `post T-${target.number}`);
    const wrongFormat = await createIssue(
      "wrong-format",
      `post #${target.number}`,
    );

    expect(before.number).toBeLessThan(after.number);
    expect(wrongFormat.number).toBeGreaterThan(after.number);
    // pre-#N and post-T-N each recorded exactly once; post-#N never.
    expect(await referencedCount(target.number)).toBe(2);

    // The format is a current value, not a one-way move: going back to #
    // has to restore # parsing for whatever is written next.
    await api("/references/format", {
      method: "PUT",
      body: JSON.stringify({ prefix: null }),
    });
    const second = await createIssue("second-target");
    await createIssue("hash-again", `now #${second.number}`);
    expect(await referencedCount(second.number)).toBe(1);
  });

  it("mirrors every switch and never lets a project contest itself", async () => {
    // Prefixes are global and this database outlives the run, so a fixed
    // "P" would be contested by every previous run's leftover project.
    const tag = slug.slice("refs-pg-".length).toUpperCase();
    const prefixes = [`P${tag}`, `Q${tag}`, `R${tag}`];

    // Four switches as fast as the API allows, with none of the settle()
    // spacing the PGlite suites use: the mirror must carry every row and
    // the holds derived from them stay a single ordered chain. What keeps
    // that reachable is that a round trip costs milliseconds — two switches
    // inside one millisecond would collapse a hold to an empty interval and
    // holdsOf (reference-directory.ts) would drop it.
    for (const prefix of [...prefixes, null]) {
      const res = await api("/references/format", {
        method: "PUT",
        body: JSON.stringify({ prefix }),
      });
      expect(res.status).toBe(200);
    }
    const config = await json(await api("/references/config"));
    const directory = await json(
      await t.app.request("/api/me/reference-directory", {
        headers: { cookie },
      }),
    );

    const held = (prefix: string) =>
      directory.entries.filter(
        (e: { prefix: string; slug: string }) =>
          e.slug === slug && e.prefix === prefix,
      );
    for (const prefix of prefixes) {
      expect(held(prefix)).toHaveLength(1);
      // The last switch released everything, so no hold stays open.
      expect(held(prefix)[0].to).not.toBeNull();
    }
    expect(
      directory.contested.filter((c: { prefix: string }) =>
        prefixes.includes(c.prefix),
      ),
    ).toEqual([]);
    // Every project-side history row reached the mirror.
    expect(config.format.history.length).toBeGreaterThanOrEqual(4);
  });
});
