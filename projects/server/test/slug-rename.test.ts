import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects, slugHistory } from "../src/db/system-schema.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const CANONICAL = "x-todou-canonical-slug";

describe("project slug rename", () => {
  let t: TestApp;
  let cookie: string;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  async function create(slug: string) {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: `Project ${slug}` }),
    });
    expect(res.status).toBe(201);
    return json(res);
  }

  const patch = (slug: string, body: Record<string, unknown>) =>
    t.app.request(`/api/projects/${slug}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(body),
    });

  const addIssue = (slug: string, title: string) =>
    t.app.request(`/api/projects/${slug}/issues`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title }),
    });

  it("renames, records the history row, and keeps the old slug routing", async () => {
    await create("rename-a");
    await addIssue("rename-a", "still here");

    const res = await patch("rename-a", { slug: "rename-a2" });
    expect(res.status).toBe(200);
    expect((await json(res)).slug).toBe("rename-a2");

    const row = (
      await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.slug, "rename-a2"))
    )[0];
    expect(row).toBeDefined();
    const history = await t.ctx.router
      .system()
      .select({ slug: slugHistory.slug })
      .from(slugHistory)
      .where(eq(slugHistory.projectId, row?.id as number));
    expect(history.map((h) => h.slug).sort()).toEqual([
      "rename-a",
      "rename-a2",
    ]);

    const viaOld = await t.app.request("/api/projects/rename-a/issues", {
      headers: { cookie },
    });
    expect(viaOld.status).toBe(200);
    expect((await json(viaOld)).items[0].title).toBe("still here");
    expect(viaOld.headers.get(CANONICAL)).toBe("rename-a2");

    const viaNew = await t.app.request("/api/projects/rename-a2/issues", {
      headers: { cookie },
    });
    expect(viaNew.status).toBe(200);
    expect(viaNew.headers.get(CANONICAL)).toBeNull();
  });

  it("reports retired slugs that still route here", async () => {
    await create("former-a");
    expect((await patch("former-a", { slug: "former-b" })).status).toBe(200);
    expect((await patch("former-b", { slug: "former-c" })).status).toBe(200);

    const res = await t.app.request("/api/projects/former-c", {
      headers: { cookie },
    });
    expect((await json(res)).former_slugs).toEqual(["former-a", "former-b"]);

    // Reached by an alias, the payload still describes the project itself.
    const alias = await t.app.request("/api/projects/former-a", {
      headers: { cookie },
    });
    const body = await json(alias);
    expect(body.slug).toBe("former-c");
    expect(alias.headers.get(CANONICAL)).toBe("former-c");
  });

  it("refuses a slug another project currently holds", async () => {
    await create("taken-a");
    await create("taken-b");
    const res = await patch("taken-a", { slug: "taken-b" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("conflict");
  });

  it("reserves a retired slug until it is explicitly reclaimed", async () => {
    await create("reserve-a");
    await addIssue("reserve-a", "old holder");
    expect((await patch("reserve-a", { slug: "reserve-a2" })).status).toBe(200);
    await create("reserve-b");

    const refused = await patch("reserve-b", { slug: "reserve-a" });
    expect(refused.status).toBe(409);
    const error = (await json(refused)).error;
    expect(error.code).toBe("slug_reserved");
    expect(error.details).toEqual({ slug: "reserve-a" });

    const taken = await patch("reserve-b", {
      slug: "reserve-a",
      reclaim: true,
    });
    expect(taken.status).toBe(200);

    // The spelling now belongs to the reclaimer, with no header saying so.
    const routed = await t.app.request("/api/projects/reserve-a/issues", {
      headers: { cookie },
    });
    expect((await json(routed)).items).toEqual([]);
    expect(routed.headers.get(CANONICAL)).toBeNull();

    const original = await t.app.request("/api/projects/reserve-a2", {
      headers: { cookie },
    });
    expect((await json(original)).former_slugs).toEqual([]);
  });

  it("lets a project take its own old slug back without reclaiming", async () => {
    await create("back-a");
    expect((await patch("back-a", { slug: "back-b" })).status).toBe(200);
    const back = await patch("back-b", { slug: "back-a" });
    expect(back.status).toBe(200);
    expect((await json(back)).slug).toBe("back-a");
  });

  it("applies the same three states to project creation", async () => {
    await create("create-a");
    expect((await patch("create-a", { slug: "create-a2" })).status).toBe(200);

    const refused = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug: "create-a", name: "Squatter" }),
    });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.code).toBe("slug_reserved");

    const allowed = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        slug: "create-a",
        name: "Squatter",
        reclaim: true,
      }),
    });
    expect(allowed.status).toBe(201);
  });

  it("keeps autolinks and slugs from shadowing each other, both ways", async () => {
    await create("shadow-a");
    await create("shadow-b");
    const link = await t.app.request(
      "/api/projects/shadow-b/references/autolinks",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          prefix: "shadow-x#",
          url_template: "https://example.com/<num>",
        }),
      },
    );
    expect(link.status).toBe(201);

    const renamed = await patch("shadow-a", { slug: "shadow-x" });
    expect(renamed.status).toBe(422);
    expect((await json(renamed)).error.message).toContain("shadow-x#");

    // The mirror direction: an autolink may not claim a retired slug either.
    expect((await patch("shadow-a", { slug: "shadow-a2" })).status).toBe(200);
    const shadowing = await t.app.request(
      "/api/projects/shadow-b/references/autolinks",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          prefix: "shadow-a#",
          url_template: "https://example.com/<num>",
        }),
      },
    );
    expect(shadowing.status).toBe(422);
    expect((await json(shadowing)).error.message).toContain("shadow-a2");
  });

  it("serves attachments through the old slug", async () => {
    await create("attach-a");
    await addIssue("attach-a", "has a file");
    const form = new FormData();
    form.set("file", new File(["potato bytes"], "notes.txt"));
    form.set("issue_number", "1");
    const uploaded = await t.app.request("/api/projects/attach-a/attachments", {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const url = (await json(uploaded)).url as string;

    expect((await patch("attach-a", { slug: "attach-a2" })).status).toBe(200);

    // The URL pasted into a comment before the rename, byte for byte.
    const download = await t.app.request(url, { headers: { cookie } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("potato bytes");
    expect(download.headers.get(CANONICAL)).toBe("attach-a2");
  });

  it("never confirms an alias to someone who cannot read the project", async () => {
    await create("private-a");
    expect((await patch("private-a", { slug: "private-a2" })).status).toBe(200);
    const stranger = await addUserWithToken(t.ctx, "slug-stranger");

    const res = await t.app.request("/api/projects/private-a/issues", {
      headers: stranger.headers,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get(CANONICAL)).toBeNull();
  });
});

describe("rename under a slug-keyed database template", () => {
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp("dedicated", {
      urlTemplate: "pglite://memory/slugkeyed-${project.slug}",
    });
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("pins the project to the database it is already using", async () => {
    const headers = { "content-type": "application/json", cookie };
    await t.app.request("/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ slug: "pin-a", name: "Pinned" }),
    });
    await t.app.request("/api/projects/pin-a/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "must survive the rename" }),
    });

    const res = await t.app.request("/api/projects/pin-a", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ slug: "pin-b" }),
    });
    expect(res.status).toBe(200);

    const row = (
      await t.ctx.router
        .system()
        .select()
        .from(projects)
        .where(eq(projects.slug, "pin-b"))
    )[0];
    expect(row?.databaseUrl).toBe("pglite://memory/slugkeyed-pin-a");

    const issues = await t.app.request("/api/projects/pin-b/issues", {
      headers: { cookie },
    });
    expect((await json(issues)).items[0].title).toBe("must survive the rename");
  });
});
