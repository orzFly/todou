import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The T-80 time-cutoff compares content.created_at against
 * ref_formats.effective_from. PGlite's clock only produces millisecond
 * timestamps, while real postgres stores microseconds in both columns —
 * so sub-millisecond orderings between a switch and adjacent writes only
 * exist here. Runs only when TODOU_TEST_POSTGRES_URL points at a live
 * server (see issue-list-postgres.test.ts).
 */
const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("reference cutoff on real postgres", () => {
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
      body: JSON.stringify({ slug, name: "Reference cutoff (postgres)" }),
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

  it("keeps microsecond-adjacent writes on the correct side of a switch", async () => {
    const target = await createIssue("target");

    // Writes packed as tightly as the API allows around the switch:
    // with microsecond precision every row still lands strictly before
    // or after effective_from, and parsing must agree with that order.
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

    // Round-trip: flip back and forth rapidly; content written between
    // two switches microseconds apart still parses under its own slice.
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

    // Four switches as fast as the API allows: on real postgres each one
    // gets its own microsecond, so the mirror must carry four rows and
    // the holds derived from them must stay a single ordered chain.
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
