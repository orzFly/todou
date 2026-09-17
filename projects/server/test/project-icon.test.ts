import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projects } from "../src/db/system-schema.ts";
import { enumerateBlobKeys } from "../src/services/storage-admin.ts";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

function iconForm(
  content: Uint8Array<ArrayBuffer> | string = PNG_BYTES,
  type = "image/png",
): FormData {
  const form = new FormData();
  form.set("file", new File([content], "icon.png", { type }));
  return form;
}

describe("project icons", () => {
  let t: TestApp;
  let cookie: string;
  let n = 0;
  const slug = () => `icons-${Date.now().toString(36)}-${n++}`;

  const createProject = async (s: string) => {
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: s, name: `Project ${s}` }),
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  const upload = (
    s: string,
    form = iconForm(),
    headers: Record<string, string> = { cookie },
  ) =>
    t.app.request(`/api/projects/${s}/icon`, {
      method: "POST",
      headers,
      body: form,
    });

  const iconKeyOf = async (id: number) =>
    (
      await t.ctx.router
        .system()
        .select({ key: projects.iconKey })
        .from(projects)
        .where(eq(projects.id, id))
    )[0]?.key ?? null;

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("serves the icon an admin uploaded, with the type it was sent as", async () => {
    const s = slug();
    const project = await createProject(s);
    const uploaded = await json(await upload(s));
    expect(uploaded.icon_url).toContain(`/api/projects/${project.id}/icon?v=`);

    const img = await t.app.request(uploaded.icon_url, { headers: { cookie } });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
  });

  it("mints the URL with the id, which a rename cannot invalidate", async () => {
    const s = slug();
    const project = await createProject(s);
    const uploaded = await json(await upload(s));
    expect(uploaded.icon_url).toContain(`/api/projects/${project.id}/icon`);
    expect(uploaded.icon_url).not.toContain(s);
  });

  it("refuses an upload from a member who is not an admin", async () => {
    const s = slug();
    await createProject(s);
    const bob = await addUserWithToken(t.ctx, `bob-${s}`);
    await t.app.request(`/api/projects/${s}/members/${bob.user.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "reader" }),
    });

    expect((await upload(s, iconForm(), bob.headers)).status).toBe(403);
    // …but that reader may still look at it.
    await upload(s);
    const img = await t.app.request(`/api/projects/${s}/icon`, {
      headers: bob.headers,
    });
    expect(img.status).toBe(200);
  });

  it("answers a non-member the way GET /projects/{slug} does", async () => {
    const s = slug();
    await createProject(s);
    await upload(s);
    const outsider = await addUserWithToken(t.ctx, `out-${s}`);

    const icon = await t.app.request(`/api/projects/${s}/icon`, {
      headers: outsider.headers,
    });
    const project = await t.app.request(`/api/projects/${s}`, {
      headers: outsider.headers,
    });
    expect(icon.status).toBe(project.status);
    expect(icon.status).toBe(404);
  });

  it("rejects a non-image, and anything over the size limit", async () => {
    // The same pair `POST /me/avatar` and `POST /agents/{id}/avatar` answer:
    // the three endpoints share their validators, so they share their
    // rejections too.
    const s = slug();
    await createProject(s);
    expect((await upload(s, iconForm("text", "text/plain"))).status).toBe(415);
    // Inside the multipart slack, so the body limit lets this through and
    // the service is what rejects it.
    expect(
      (await upload(s, iconForm(new Uint8Array(2 * 1024 * 1024 + 1)))).status,
    ).toBe(413);
  });

  it("cuts off a body too large to be worth parsing", async () => {
    // The scoped limit stands in front of the handler, so a genuinely huge
    // upload never gets buffered: 413 before the service sees a file.
    const s = slug();
    await createProject(s);
    const huge = await upload(s, iconForm(new Uint8Array(4 * 1024 * 1024)));
    expect(huge.status).toBe(413);
  });

  it("changes the URL on replacement and drops the old blob", async () => {
    const s = slug();
    const project = await createProject(s);
    const first = await json(await upload(s));
    const oldKey = await iconKeyOf(project.id);
    expect(oldKey).not.toBe(null);

    const second = await json(
      await upload(s, iconForm(PNG_BYTES, "image/gif")),
    );
    expect(second.icon_url).not.toBe(first.icon_url);
    // The row points at the new blob and the old one is gone from storage.
    expect(await iconKeyOf(project.id)).not.toBe(oldKey);
    expect(await t.ctx.storage.head(oldKey as string)).toBe(null);
  });

  it("deletes idempotently, and 404s the image afterwards", async () => {
    const s = slug();
    await createProject(s);
    const uploaded = await json(await upload(s));

    const remove = () =>
      t.app.request(`/api/projects/${s}/icon`, {
        method: "DELETE",
        headers: { cookie },
      });
    const removed = await json(await remove());
    expect(removed.icon_url).toBe(null);
    // Deleting again is still a 200 — same as DELETE /me/avatar.
    expect((await remove()).status).toBe(200);

    const img = await t.app.request(uploaded.icon_url, { headers: { cookie } });
    expect(img.status).toBe(404);
  });

  it("carries icon_url through every endpoint that names a project", async () => {
    const s = slug();
    await createProject(s);
    const uploaded = await json(await upload(s));

    const list = await json(
      await t.app.request("/api/projects", { headers: { cookie } }),
    );
    expect(list.find((p: { slug: string }) => p.slug === s).icon_url).toBe(
      uploaded.icon_url,
    );

    const one = await json(
      await t.app.request(`/api/projects/${s}`, { headers: { cookie } }),
    );
    expect(one.icon_url).toBe(uploaded.icon_url);

    // The ProjectBrief exit, which the bot list's project chips read.
    const agent = await json(
      await t.app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ login: `bot-${s}`, display_name: "Bot" }),
      }),
    );
    await t.app.request(`/api/projects/${s}/members/${agent.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ role: "reader" }),
    });
    const memberships = await json(
      await t.app.request("/api/me/agent-memberships", {
        headers: { cookie },
      }),
    );
    const membership = memberships.memberships.find(
      (m: { project: { slug: string } }) => m.project.slug === s,
    );
    expect(membership.project.icon_url).toBe(uploaded.icon_url);
  });

  it("is enumerated for storage migration, and swept up with the project", async () => {
    const s = slug();
    const project = await createProject(s);
    await upload(s);
    const key = (await iconKeyOf(project.id)) as string;

    // enumerateBlobKeys is the source of truth for a storage move; an icon
    // missing from it would vanish silently on the next backend change.
    const keys = await enumerateBlobKeys(t.ctx.router);
    expect(keys.map((k) => k.key)).toContain(key);
    expect(keys.find((k) => k.key === key)?.origin).toBe(`icon:${s}`);

    const deleted = await t.app.request(`/api/projects/${s}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(deleted.status).toBe(204);
    expect(await t.ctx.storage.head(key)).toBe(null);
  });
});
