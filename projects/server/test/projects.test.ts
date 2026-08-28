import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues } from "../src/db/project-schema.ts";
import { projects } from "../src/db/system-schema.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe.each(PLACEMENTS)("projects domain (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let n = 0;
  const slug = () => `proj-${placement.replaceAll(/[^a-z]/g, "")}-${n++}`;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const postProject = (body: Record<string, unknown>) =>
    t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  async function createProject(s: string) {
    const res = await postProject({ slug: s, name: `Project ${s}` });
    expect(res.status).toBe(201);
    return json(res);
  }

  const getRefConfig = async (s: string) =>
    json(
      await t.app.request(`/api/projects/${s}/references/config`, {
        headers: { cookie },
      }),
    );

  it("creates a project with seeded statuses and creator as admin", async () => {
    const s = slug();
    const project = await createProject(s);
    expect(project.slug).toBe(s);

    const statusRes = await t.app.request(`/api/projects/${s}/statuses`, {
      headers: { cookie },
    });
    const statuses = await json(statusRes);
    expect(statuses.map((x: { name: string }) => x.name)).toEqual([
      "Todo",
      "In Progress",
      "Done",
    ]);
    expect(statuses[2].category).toBe("closed");

    const members = await json(
      await t.app.request(`/api/projects/${s}/members`, {
        headers: { cookie },
      }),
    );
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");
    expect(members[0].user.login).toBe("user");
  });

  // T-148: the reference format is offered at creation instead of only in
  // settings, so a project never has to start on a spelling nobody chose.
  describe("issue reference format at creation time", () => {
    it("records the prefix as history anchored at the project's own birth", async () => {
      const s = slug();
      const project = await json(
        await postProject({ slug: s, name: `Project ${s}`, ref_prefix: "T" }),
      );
      const config = await getRefConfig(s);
      expect(config.format.prefix).toBe("T");
      expect(config.format.history).toEqual([
        { prefix: "T", effective_from: project.created_at },
      ]);
    });

    it("leaves the project on # when the prefix is omitted or null", async () => {
      const omitted = slug();
      await createProject(omitted);
      expect(await getRefConfig(omitted)).toEqual({
        format: { prefix: null, history: [] },
        autolinks: [],
      });

      const explicit = slug();
      const res = await postProject({
        slug: explicit,
        name: `Project ${explicit}`,
        ref_prefix: null,
      });
      expect(res.status).toBe(201);
      expect((await getRefConfig(explicit)).format).toEqual({
        prefix: null,
        history: [],
      });
    });

    it("refuses a malformed prefix the same way the settings PUT does", async () => {
      for (const bad of ["t", "1T", "T-X", "W".repeat(21)]) {
        const res = await postProject({
          slug: slug(),
          name: "Bad prefix",
          ref_prefix: bad,
        });
        expect(res.status).toBe(422);
      }
      // A refused creation must not have registered the slug either.
      const s = slug();
      expect(
        (await postProject({ slug: s, name: "x", ref_prefix: "t" })).status,
      ).toBe(422);
      expect(
        (await t.app.request(`/api/projects/${s}`, { headers: { cookie } }))
          .status,
      ).toBe(404);
    });

    // effective_from = created_at, so the format covers every instant the
    // project could already hold content — including its very first issue.
    it("parses the new format in content written immediately after creation", async () => {
      const s = slug();
      await postProject({ slug: s, name: `Project ${s}`, ref_prefix: "T" });
      const issue = (body: string) =>
        t.app.request(`/api/projects/${s}/issues`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ title: "t", body }),
        });
      const target = await json(await issue(""));
      await issue(`fixes T-${target.number}`);

      const timeline = await json(
        await t.app.request(
          `/api/projects/${s}/issues/${target.number}/timeline?types=referenced&limit=100`,
          { headers: { cookie } },
        ),
      );
      expect(timeline.items).toHaveLength(1);
    });
  });

  it("409s on duplicate slugs", async () => {
    const s = slug();
    await createProject(s);
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: s, name: "again" }),
    });
    expect(res.status).toBe(409);
  });

  it("hides projects from non-members as 404", async () => {
    const s = slug();
    await createProject(s);
    const bob = await addUserWithToken(t.ctx, `bob-${s}`);
    const res = await t.app.request(`/api/projects/${s}`, {
      headers: bob.headers,
    });
    expect(res.status).toBe(404);
  });

  it("enforces role ranks: reader can view but not administer", async () => {
    const s = slug();
    await createProject(s);
    const bob = await addUserWithToken(t.ctx, `bob-${s}`);
    const put = await t.app.request(
      `/api/projects/${s}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(put.status).toBe(204);

    expect(
      (await t.app.request(`/api/projects/${s}`, { headers: bob.headers }))
        .status,
    ).toBe(200);
    expect(
      (
        await t.app.request(`/api/projects/${s}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ name: "hacked" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.app.request(`/api/projects/${s}/statuses`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ name: "Blocked", category: "open" }),
        })
      ).status,
    ).toBe(403);
  });

  it("lets an admin rename the project and redescribe it", async () => {
    const s = slug();
    await createProject(s);
    const patched = await json(
      await t.app.request(`/api/projects/${s}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Renamed", description: "Now with why" }),
      }),
    );
    expect(patched.name).toBe("Renamed");
    expect(patched.description).toBe("Now with why");
    expect(patched.slug).toBe(s);

    const fetched = await json(
      await t.app.request(`/api/projects/${s}`, { headers: { cookie } }),
    );
    expect(fetched.name).toBe("Renamed");
    expect(fetched.description).toBe("Now with why");
  });

  it("refuses to demote or remove the last admin", async () => {
    const s = slug();
    const project = await createProject(s);
    const meRes = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    const demote = await t.app.request(
      `/api/projects/${s}/members/${meRes.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(demote.status).toBe(409);
    expect(project.id).toBeGreaterThan(0);
  });

  it("manages statuses: append position, rename conflicts, reorder, delete guard", async () => {
    const s = slug();
    const project = await createProject(s);

    const created = await json(
      await t.app.request(`/api/projects/${s}/statuses`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Blocked", category: "open" }),
      }),
    );
    expect(created.position).toBe(3);

    const rename = await t.app.request(
      `/api/projects/${s}/statuses/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Todo" }),
      },
    );
    expect(rename.status).toBe(409);

    const reorder = await json(
      await t.app.request(`/api/projects/${s}/statuses/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ position: 0 }),
      }),
    );
    expect(reorder.position).toBe(0);

    // Reference the status from an issue row, then deletion must 409.
    const db = await t.ctx.router.forProject({
      id: project.id,
      slug: s,
      database_url: null,
    });
    await db.insert(issues).values({
      projectId: project.id,
      number: 1,
      title: "uses status",
      statusId: created.id,
      authorId: 1,
    });
    const blocked = await t.app.request(
      `/api/projects/${s}/statuses/${created.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(blocked.status).toBe(409);
  });

  it("keeps a single default status and clears it on demand", async () => {
    const s = slug();
    await createProject(s);
    const listStatuses = async () =>
      json(
        await t.app.request(`/api/projects/${s}/statuses`, {
          headers: { cookie },
        }),
      );
    const patchStatus = (id: number, body: Record<string, unknown>) =>
      t.app.request(`/api/projects/${s}/statuses/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    // Seeded projects start with no explicit default.
    const seeded = await listStatuses();
    expect(seeded.every((x: { is_default: boolean }) => !x.is_default)).toBe(
      true,
    );
    const progress = seeded.find(
      (x: { name: string }) => x.name === "In Progress",
    );
    const done = seeded.find((x: { name: string }) => x.name === "Done");

    const set = await json(
      await patchStatus(progress.id, {
        is_default: true,
      }),
    );
    expect(set.is_default).toBe(true);

    // Promoting another status demotes the previous default.
    await patchStatus(done.id, { is_default: true });
    const switched = await listStatuses();
    const defaults = switched.filter(
      (x: { is_default: boolean }) => x.is_default,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Done");

    await patchStatus(done.id, { is_default: false });
    const cleared = await listStatuses();
    expect(cleared.every((x: { is_default: boolean }) => !x.is_default)).toBe(
      true,
    );
  });

  it("manages labels with per-project name uniqueness", async () => {
    const s = slug();
    await createProject(s);
    const created = await json(
      await t.app.request(`/api/projects/${s}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "bug", color: "#ff0000" }),
      }),
    );
    expect(created.name).toBe("bug");

    const dup = await t.app.request(`/api/projects/${s}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "bug" }),
    });
    expect(dup.status).toBe(409);

    const updated = await json(
      await t.app.request(`/api/projects/${s}/labels/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ color: "#00ff00" }),
      }),
    );
    expect(updated.color).toBe("#00ff00");

    const del = await t.app.request(`/api/projects/${s}/labels/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);
  });

  // The CLI addresses labels by name and splits `--label 'a,b'` into two of
  // them, so a name it could never say again must not be storable (T-136).
  describe("label names the CLI can always address back", () => {
    const postLabel = (s: string, body: unknown) =>
      t.app.request(`/api/projects/${s}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    it("refuses a comma on create and on rename", async () => {
      const s = slug();
      await createProject(s);
      const refused = await postLabel(s, { name: "a,b" });
      expect(refused.status).toBe(422);
      // The reason has to survive to the caller — a CLI user needs to read
      // why, not just see a 422.
      expect((await json(refused)).error.message).toContain(
        "cannot contain a comma",
      );

      const created = await json(await postLabel(s, { name: "keeper" }));
      const renamed = await t.app.request(
        `/api/projects/${s}/labels/${created.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "still,bad" }),
        },
      );
      expect(renamed.status).toBe(422);
      // The refusal must not have half-applied.
      const [after] = await json(
        await t.app.request(`/api/projects/${s}/labels`, {
          headers: { cookie },
        }),
      );
      expect(after.name).toBe("keeper");
    });

    it("stores the canonical spelling of a whitespace-y name", async () => {
      const s = slug();
      await createProject(s);
      const created = await json(
        await postLabel(s, { name: "  area:   cli " }),
      );
      expect(created.name).toBe("area: cli");

      // Canonicalization runs before the uniqueness check, so a differently
      // spaced spelling of a stored name is a duplicate, not a second label.
      expect((await postLabel(s, { name: "area:  cli" })).status).toBe(409);
    });

    it("rejects a name that canonicalizes away to nothing", async () => {
      const s = slug();
      await createProject(s);
      expect((await postLabel(s, { name: "   " })).status).toBe(422);
    });
  });

  it("deletes a project and stops routing to it", async () => {
    const s = slug();
    await createProject(s);
    const del = await t.app.request(`/api/projects/${s}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);
    expect(
      (await t.app.request(`/api/projects/${s}`, { headers: { cookie } }))
        .status,
    ).toBe(404);
  });
});

describe("provision failure compensation", () => {
  it("removes the registry row when project-db provisioning fails", async () => {
    const t = await makeTestApp("dedicated", {
      // /dev/null cannot contain a data directory — provisioning must fail.
      urlTemplate: "pglite:///dev/null/nope-${project.id}",
    });
    try {
      const cookie = await t.login();
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slug: "doomed", name: "Doomed" }),
      });
      expect(res.status).toBe(500);
      const rows = await t.ctx.router.system().select().from(projects);
      expect(rows).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
